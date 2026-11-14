import { Handler } from "aws-lambda";
import { QueryCommand, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { META_ERROR_CODES, extractKnownErrorCode } from "../../lib/error-codes";

/**
 * Runs every 5 minutes: finds campaigns failing for a reason that is on OUR side
 * (billing, template, parameters, token, media, account restriction) and sends a
 * WhatsApp alert to a few operator numbers.
 *
 * Recipient-side failures (131026 not on WhatsApp, 131049/131050 ecosystem/opt-out,
 * 131000 unknown, …) are deliberately ignored — they happen on every campaign and
 * nobody can fix them.
 *
 * Both failure paths are covered by reading the stored messages rather than
 * hooking the send: send-worker.ts writes immediate API failures (132001, 131008)
 * and webhook-worker.ts writes async delivery failures (131042, 131053), both
 * with the bare numeric errorCode and GSI3PK = CAMP#<id>#STATUS#failed.
 *
 * One alert per (root campaign, error code), ever: a Retry-Failed follow-up
 * shares its parent's dedup key, so a retry failing for the same reason doesn't
 * re-alert. Dedup rows live in the notifications table under PK "FAILALERT",
 * which the in-app notifications list (PK "ACTIVE") never reads.
 */

const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE || "";
const RECIPIENTS = (process.env.ALERT_RECIPIENTS || "").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean);
// "<businessId>:<phoneNumberId>" in fallback order — ideally on different
// businesses/WABAs, so a billing block on one doesn't also silence the alert.
const SENDERS = (process.env.ALERT_SENDERS || "")
  .split(",")
  .map((s) => s.trim().split(":"))
  .filter((p) => p.length === 2 && p[0] && p[1])
  .map(([businessId, phoneNumberId]) => ({ businessId, phoneNumberId }));
const TEMPLATE_NAME = process.env.ALERT_TEMPLATE_NAME || "campaign_failure_alert";
const TEMPLATE_LANG = process.env.ALERT_TEMPLATE_LANG || "en";
const MIN_FAILURES = Number(process.env.ALERT_MIN_FAILURES || "5");
const ACCOUNT_LABEL = process.env.ALERT_ACCOUNT_LABEL || "";
// Completed campaigns stay in scope this long, since async webhook failures
// (131042 etc.) keep landing for a while after the last send.
const COMPLETED_LOOKBACK_MS = 3 * 60 * 60 * 1000;

/** Failure codes caused by our setup, not the recipient. */
export const BUSINESS_SIDE_CODES = new Set([
  "131042", // payment
  "131008", "131009", "132000", "132012", "100", // parameters
  "132001", "132005", "132007", "132015", "132016", "131063", // template
  "131053", // media header couldn't be fetched
  "0", "3", "10", "190", "200", "131005", // token / permissions
  "368", "130497", "131031", // account restricted
  "33", "131037", "131045", "133010", "131057", // number setup
  "4", "80007", "130429", "131064", // rate limits
]);

const SHORT_LABEL: Record<string, string> = {
  "131042": "Payment issue",
  "131008": "Missing template parameter",
  "131009": "Invalid parameter value",
  "132000": "Parameter count mismatch",
  "132012": "Parameter format wrong",
  "132001": "Template not found or not approved",
  "132015": "Template paused (low quality)",
  "132016": "Template disabled",
  "131053": "Image/media could not be loaded",
  "190": "Access token expired",
  "368": "Account restricted",
  "131031": "Account restricted",
  "130429": "Throughput limit hit",
  "131064": "Messaging limit (template classification)",
};

function labelFor(code: string): string {
  return SHORT_LABEL[code] || META_ERROR_CODES[code]?.label || `Error ${code}`;
}

/** Meta rejects template params containing newlines, tabs or 4+ spaces. */
function param(text: string, max = 300): { type: "text"; text: string } {
  const clean = text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
  return { type: "text", text: clean || "-" };
}

async function queryAll(input: ConstructorParameters<typeof QueryCommand>[0]) {
  const items: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const res = await docClient.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const businessCache = new Map<string, Record<string, any> | undefined>();
async function getBusiness(businessId: string) {
  if (!businessCache.has(businessId)) {
    const res = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    businessCache.set(businessId, res.Item);
  }
  return businessCache.get(businessId);
}

/** Tries each sender in order; returns which one worked, or null. */
async function sendAlert(to: string, params: string[]): Promise<string | null> {
  for (const s of SENDERS) {
    const token = (await getBusiness(s.businessId))?.accessToken;
    if (!token) continue;
    try {
      const res = await fetch(`https://graph.facebook.com/v25.0/${s.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: TEMPLATE_NAME,
            language: { code: TEMPLATE_LANG },
            components: [{ type: "body", parameters: params.map((p) => param(p)) }],
          },
        }),
      });
      const data = (await res.json()) as { messages?: { id: string }[]; error?: { code?: number; message?: string } };
      if (data.messages?.[0]?.id) return s.phoneNumberId;
      console.warn(`Alert via ${s.phoneNumberId} to ${to} failed:`, data.error?.code, data.error?.message);
    } catch (err) {
      console.warn(`Alert via ${s.phoneNumberId} to ${to} threw:`, err);
    }
  }
  return null;
}

export const handler: Handler = async () => {
  if (!RECIPIENTS.length || !SENDERS.length || !NOTIFICATIONS_TABLE) {
    console.log("Failure alerts not configured (ALERT_RECIPIENTS / ALERT_SENDERS / NOTIFICATIONS_TABLE) — skipping");
    return;
  }
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayIST = nowIST.toISOString().slice(0, 10);

  const running = await queryAll({
    TableName: TABLES.CAMPAIGNS,
    IndexName: "GSI2",
    KeyConditionExpression: "GSI2PK = :pk",
    ExpressionAttributeValues: { ":pk": "STATUS#running" },
  });
  const finished = (
    await Promise.all(
      ["completed", "failed"].map((st) =>
        queryAll({
          TableName: TABLES.CAMPAIGNS,
          IndexName: "GSI2",
          KeyConditionExpression: "GSI2PK = :pk AND begins_with(GSI2SK, :d)",
          ExpressionAttributeValues: { ":pk": `STATUS#${st}`, ":d": todayIST },
        })
      )
    )
  )
    .flat()
    .filter((c) => {
      const t = Date.parse(c.completedAt || c.updatedAt || "");
      return !t || Date.now() - t < COMPLETED_LOOKBACK_MS;
    });

  const campaigns = [...running, ...finished];
  console.log(`Failure-alert sweep: ${campaigns.length} campaign(s) in scope`);

  for (const camp of campaigns) {
    const campaignId = String(camp.PK || "").replace(/^CAMP#/, "");
    if (!campaignId) continue;
    try {
      const failed = await queryAll({
        TableName: TABLES.MESSAGES,
        IndexName: "GSI3",
        KeyConditionExpression: "GSI3PK = :pk",
        ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}#STATUS#failed` },
        ProjectionExpression: "errorCode, sendingNumberId",
      });

      const byCode = new Map<string, { count: number; senders: Set<string> }>();
      for (const m of failed) {
        // Bare codes are taken as-is: extractKnownErrorCode needs 3+ digits, which
        // would miss short ones like 0/3/10 (token problems).
        const raw = String(m.errorCode ?? "").trim();
        const code = /^\d+$/.test(raw) ? raw : extractKnownErrorCode(raw);
        if (!code || !BUSINESS_SIDE_CODES.has(code)) continue;
        const e = byCode.get(code) || { count: 0, senders: new Set<string>() };
        e.count++;
        if (m.sendingNumberId) e.senders.add(String(m.sendingNumberId));
        byCode.set(code, e);
      }

      const rootId = camp.parentCampaignId || campaignId;
      const claimed: string[] = [];
      for (const [code, e] of byCode) {
        if (e.count < MIN_FAILURES) continue;
        try {
          await docClient.send(
            new PutCommand({
              TableName: NOTIFICATIONS_TABLE,
              Item: {
                PK: "FAILALERT",
                SK: `${rootId}#${code}`,
                campaignId,
                campaignName: camp.campaignName,
                code,
                count: e.count,
                createdAt: new Date().toISOString(),
                ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            })
          );
          claimed.push(code);
        } catch (err: any) {
          if (err?.name !== "ConditionalCheckFailedException") throw err;
        }
      }
      if (!claimed.length) continue;

      // Show sending numbers as their last 4 digits, the way the team refers to them.
      const biz = await getBusiness(camp.businessId);
      const display = new Map<string, string>(
        ((biz?.phoneNumbers || []) as { phoneNumberId: string; displayNumber?: string }[]).map((p) => [
          p.phoneNumberId,
          (p.displayNumber || p.phoneNumberId).slice(-4),
        ])
      );
      const reasons = claimed.map((c) => `${labelFor(c)} (${c}) x${byCode.get(c)!.count}`).join("; ");
      const total = claimed.reduce((n, c) => n + byCode.get(c)!.count, 0);
      const senderSet = new Set(claimed.flatMap((c) => [...byCode.get(c)!.senders]));
      const senderList = [...senderSet].map((id) => display.get(id) || id.slice(-4));
      const senders = senderList.length > 12
        ? `${senderList.slice(0, 12).join(", ")} +${senderList.length - 12} more`
        : senderList.join(", ");
      const when = `${ACCOUNT_LABEL ? ACCOUNT_LABEL + ", " : ""}${camp.scheduleDate || todayIST} ${camp.scheduleTime || ""}`.trim();

      const params = [camp.campaignName || campaignId, reasons, String(total), senders || "-", when];
      let delivered = 0;
      for (const to of RECIPIENTS) {
        const via = await sendAlert(to, params);
        if (via) delivered++;
        else console.error(`Could not alert ${to} about ${campaignId} — all alert senders failed`);
      }
      console.log(`Alerted ${delivered}/${RECIPIENTS.length} about ${campaignId}: ${reasons}`);

      // Nobody got it — release the claim so the next sweep tries again.
      if (!delivered) {
        await Promise.all(
          claimed.map((code) =>
            docClient.send(new DeleteCommand({ TableName: NOTIFICATIONS_TABLE, Key: { PK: "FAILALERT", SK: `${rootId}#${code}` } }))
          )
        );
      }
    } catch (err) {
      console.error(`Failure-alert check failed for ${campaignId}:`, err);
    }
  }
};
