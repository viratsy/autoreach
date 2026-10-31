import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand, QueryCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getProvider } from "../../lib/providers";
import { PhoneNumber } from "../../lib/types";
import { getAuthEmail } from "../../lib/auth";

/**
 * Fetch templates from Meta API for a given business.
 * Uses each phone number's wabaid to fetch templates.
 * POST /templates/fetch { businessId, templateName?, clearFirst?, phoneNumberId? }
 * With templateName, only that one template (across every number) is
 * re-synced — for refreshing a single row's status without re-pulling the
 * whole catalog.
 * With clearFirst, every existing template row for this business is deleted
 * before re-fetching — a genuine clean slate that also drops rows for
 * templates Meta no longer returns (deleted/renamed on Meta's side), which a
 * normal sync's upsert-only writes can never clear on their own. Mutually
 * exclusive with templateName — clearing everything to refresh one row makes
 * no sense.
 * With phoneNumberId, only that one number's WABA is called — a single Meta
 * request instead of fanning out to every number at once, useful for
 * isolating whether a specific number's sync issue is real (its WABA
 * genuinely has no/partial templates) versus an artifact of the concurrent
 * fan-out (rate limiting, timeout contention under load).
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const { businessId, templateName: syncTemplateName, clearFirst, phoneNumberId: syncPhoneNumberId } = JSON.parse(event.body || "{}");
    if (!businessId) return error(400, "businessId is required", origin);
    if (clearFirst && syncTemplateName) {
      return error(400, "clearFirst can't be combined with a single templateName resync", origin);
    }
    if (clearFirst && syncPhoneNumberId) {
      return error(400, "clearFirst can't be combined with a single phoneNumberId resync", origin);
    }

    if (clearFirst) {
      await clearExistingTemplates(businessId);
    }

    // Get business record
    const bizResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.BUSINESSES,
        Key: { PK: `BIZ#${businessId}`, SK: "METADATA" },
      })
    );

    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);

    const provider = (business.provider as string) || "meta";
    let phoneNumbers = (business.phoneNumbers || []) as PhoneNumber[];

    if (syncPhoneNumberId) {
      phoneNumbers = phoneNumbers.filter((pn) => pn.phoneNumberId === syncPhoneNumberId);
      if (phoneNumbers.length === 0) {
        return error(404, "Phone number not found on this business", origin);
      }
    }

    if (provider === "aisensy") {
      return error(400, "AiSensy has no template-list API — add templates manually via /templates/manual", origin);
    }

    if (provider === "wati") {
      const wati = getProvider("wati")!;
      const allTemplates: Record<string, string[]> = {};
      for (const pn of phoneNumbers) {
        const fetched = await wati.fetchTemplates!(pn);
        // WATI's API has no server-side name filter — scope to one template
        // client-side instead so a single-template sync still only writes
        // that one row, matching what the caller asked for.
        const templates = syncTemplateName ? fetched.filter((t) => t.name === syncTemplateName) : fetched;
        for (const tpl of templates) {
          await docClient.send(
            new PutCommand({
              TableName: TABLES.TEMPLATES,
              Item: {
                PK: `BIZ#${businessId}`,
                SK: `TPL#${pn.phoneNumberId}#${tpl.name}`,
                templateName: tpl.name,
                language: tpl.language,
                category: tpl.category,
                components: tpl.components,
                parameterCount: countParameters(tpl.components),
                status: tpl.status,
                source: "wati",
                lastSyncedAt: new Date().toISOString(),
              },
            })
          );
        }
        allTemplates[pn.phoneNumberId] = templates.map((t) => t.name);
      }
      return success({ templates: allTemplates }, origin);
    }

    const accessToken = business.accessToken;

    // Statuses that mean a template is genuinely gone and never sendable —
    // everything else (APPROVED, PENDING, PAUSED, IN_APPEAL, DISABLED, ...)
    // still gets synced and stored, since list.ts already surfaces each
    // template's real per-number status for the UI to warn on. Silently
    // dropping anything short of APPROVED here (the previous behavior) meant
    // a template stuck in quality review, or paused for low quality, would
    // never even appear as "not synced" — it would just vanish entirely.
    const DEAD_STATUSES = new Set(["REJECTED", "DELETED", "PENDING_DELETION"]);
    // Real logs showed a couple of numbers aborting at 15s once ~30-40
    // numbers started hitting Meta concurrently (this function now fans out
    // to all of them at once) — 20s gives more headroom while still leaving
    // margin under the 28s Lambda timeout below.
    const PER_WABA_TIMEOUT_MS = 20000;

    type MetaTemplate = { name: string; language: string; category: string; status: string; components: unknown[] };

    // A business can have 30-40+ numbers, each with dozens of templates —
    // fetching (with pagination) and storing them strictly one number at a
    // time, one PutCommand per template, was measured taking 43-56s for 38
    // numbers (real logs) — past API Gateway's hard 29s cutoff (so the
    // frontend silently times out mid-run) and flirting with this function's
    // own 60s Lambda timeout (which would truncate whichever numbers hadn't
    // been reached yet — exactly the "some numbers never sync" symptom this
    // was causing). Fetching every number concurrently, each with its own
    // timeout so one hung WABA can't stall the rest, is the same fix already
    // applied to whatsapp-spend.ts for the identical root cause.
    async function syncOneNumber(pn: PhoneNumber): Promise<{ phoneNumberId: string; names: string[] } | null> {
      const wabaid = pn.wabaid;
      if (!wabaid) return null;

      const templates: MetaTemplate[] = [];
      let nextUrl: string | undefined = syncTemplateName
        ? `https://graph.facebook.com/v25.0/${wabaid}/message_templates?limit=100&name=${encodeURIComponent(syncTemplateName)}`
        : `https://graph.facebook.com/v25.0/${wabaid}/message_templates?limit=100`;

      // Follow pagination — a WABA with more than 100 templates would
      // otherwise silently lose everything past the first page.
      while (nextUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PER_WABA_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(nextUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal,
          });
        } catch (err) {
          console.error(`Templates fetch timed out/failed for ${pn.phoneNumberId}:`, err);
          break;
        } finally {
          clearTimeout(timer);
        }

        const data = (await response.json()) as {
          data?: MetaTemplate[];
          paging?: { next?: string };
          error?: unknown;
        };

        if (!response.ok || !data.data) {
          console.error(`Failed to fetch templates for ${pn.phoneNumberId}:`, data.error);
          break;
        }

        templates.push(...data.data.filter((t) => !DEAD_STATUSES.has(t.status)));
        nextUrl = data.paging?.next;
      }

      // Meta returns one row PER LANGUAGE VARIANT of a template, so the same
      // name can appear more than once here — but our SK is phoneNumberId+name
      // only (no language), so two same-named entries landing in the same
      // BatchWriteCommand slice is a duplicate key within one batch, which
      // DynamoDB rejects outright (ValidationException, killing the WHOLE
      // request — this took down every number's sync, not just the
      // duplicated one, since it wasn't caught and rejected the Promise.all
      // this runs inside). Dedupe by name first — last variant wins, same as
      // what the old sequential-PutCommand code did implicitly.
      const byName = new Map<string, MetaTemplate>();
      for (const tpl of templates) byName.set(tpl.name, tpl);
      const deduped = [...byName.values()];

      // Batch the writes (25 at a time) instead of one PutCommand per
      // template — with dozens of templates per number this is the other
      // half of what made the whole sync so slow.
      const DYNAMO_BATCH = 25;
      for (let i = 0; i < deduped.length; i += DYNAMO_BATCH) {
        const slice = deduped.slice(i, i + DYNAMO_BATCH);
        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [TABLES.TEMPLATES]: slice.map((tpl) => ({
                PutRequest: {
                  Item: {
                    PK: `BIZ#${businessId}`,
                    SK: `TPL#${pn.phoneNumberId}#${tpl.name}`,
                    templateName: tpl.name,
                    language: tpl.language,
                    category: tpl.category,
                    components: tpl.components,
                    parameterCount: countParameters(tpl.components),
                    status: tpl.status.toLowerCase(),
                    lastSyncedAt: new Date().toISOString(),
                  },
                },
              })),
            },
          })
        );
      }

      return { phoneNumberId: pn.phoneNumberId, names: deduped.map((t) => t.name) };
    }

    // One number's fetch/write failing (rate limit, transient DynamoDB error,
    // whatever) must not take down every other number's already-successful
    // sync — Promise.all rejects as a whole on the first unhandled rejection,
    // which is exactly what turned one bad WABA into "the entire Clear &
    // Resync did nothing."
    const results = await Promise.all(
      phoneNumbers.map((pn) =>
        syncOneNumber(pn).catch((err) => {
          console.error(`syncOneNumber failed for ${pn.phoneNumberId}:`, err);
          return null;
        })
      )
    );

    const allTemplates: Record<string, string[]> = {};
    for (const r of results) {
      if (r) allTemplates[r.phoneNumberId] = r.names;
    }

    return success({ templates: allTemplates }, origin);
  } catch (err) {
    console.error("Template fetch error:", err);
    return error(500, "Failed to fetch templates", origin);
  }
};

async function clearExistingTemplates(businessId: string) {
  let lastKey: Record<string, unknown> | undefined;
  const keys: { PK: string; SK: string }[] = [];
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLES.TEMPLATES,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `BIZ#${businessId}` },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of result.Items || []) {
      keys.push({ PK: item.PK as string, SK: item.SK as string });
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const DYNAMO_BATCH = 25;
  for (let i = 0; i < keys.length; i += DYNAMO_BATCH) {
    const slice = keys.slice(i, i + DYNAMO_BATCH);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLES.TEMPLATES]: slice.map((key) => ({ DeleteRequest: { Key: key } })),
        },
      })
    );
  }

  console.log(`Cleared ${keys.length} existing template row(s) for business ${businessId}`);
}

function countParameters(components: unknown[]): number {
  let count = 0;
  for (const comp of components as { type: string; text?: string }[]) {
    if (comp.type === "BODY" && comp.text) {
      const matches = comp.text.match(/\{\{\d+\}\}/g);
      count += matches ? matches.length : 0;
    }
  }
  return count;
}
