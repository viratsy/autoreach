import { Handler } from "aws-lambda";
import { ScanCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { docClient, TABLES } from "../../lib/dynamo";
import { BusinessRecord, PhoneNumber } from "../../lib/types";

const lambda = new LambdaClient({});
const TARGET_FUNCTION = process.env.ROTATION_TARGET_FUNCTION || "free_workshop_meta";

// Lambda caps ALL environment variables at 4KB combined. Staying under a
// slightly lower ceiling leaves room for the other vars (tokens, origins) to
// grow a little without a rotation suddenly becoming unwritable.
const ENV_BUDGET_BYTES = 3800;

// Never hand free_workshop_meta a pool smaller than this — an empty or
// near-empty pool means real signups stop getting their WhatsApp confirmation.
const MIN_POOL = 5;

// Quality tiers that belong in this pool. The pool deliberately carries the
// DEGRADED numbers: signup confirmations are opt-in, genuinely wanted messages,
// so they generate positive engagement that helps a number recover, while the
// GREEN numbers stay reserved for the heavier campaign sending.
// SIGNUP_POOL_QUALITIES narrows it per account (Navin runs RED only).
const DEGRADED = new Set(
  (process.env.SIGNUP_POOL_QUALITIES || "RED,YELLOW,UNKNOWN")
    .split(",")
    .map((q) => q.trim().toUpperCase())
    .filter(Boolean)
);

interface Candidate {
  businessId: string;
  phoneNumberId: string;
  displayNumber: string;
  quality: string;
}

/**
 * Daily rebuild of free_workshop_meta's sender pool, keyed off each number's
 * live quality rating.
 *
 * Writes ONLY the WA_SENDER_POOL variable (number IDs grouped by business) —
 * never the WA_TOKEN_* variables, so a bug here can't clobber or leak a
 * credential. free_workshop_meta expands business -> token at send time.
 *
 * Runs after the 8:30 AM template sync so a template approved overnight is
 * already visible when eligibility is checked.
 */
export const handler: Handler = async () => {
  console.log(`Number rotation started (target=${TARGET_FUNCTION})`);

  try {
    const current = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: TARGET_FUNCTION }));
    const env = { ...(current.Environment?.Variables || {}) };

    const requiredTemplate = (env.WA_DEFAULT_TEMPLATE || "").trim();
    const lang = (env.WA_DEFAULT_LANG || "en").trim();
    if (!requiredTemplate) {
      console.error("Target function has no WA_DEFAULT_TEMPLATE — aborting without changes");
      return;
    }

    const bizResult = await docClient.send(new ScanCommand({ TableName: TABLES.BUSINESSES }));
    const businesses = (bizResult.Items || []) as BusinessRecord[];

    const pool: Record<string, { template: string; lang: string; numbers: string[] }> = {};
    let totalDegraded = 0;
    let totalGreen = 0;

    for (const business of businesses) {
      if ((business.provider || "meta") !== "meta") continue;

      // A business only participates if the target function actually holds a
      // token for it — otherwise its numbers would be silently skipped at send
      // time anyway, and listing them here would just be noise.
      const tokenKey = `WA_TOKEN_${business.businessId.toUpperCase()}`;
      if (!env[tokenKey]) {
        console.log(`${business.businessId}: no ${tokenKey} on target function, skipping`);
        continue;
      }

      const numbers = (business.phoneNumbers || []) as PhoneNumber[];
      if (numbers.length === 0) continue;

      const approvedOn = await numbersWithTemplate(business.businessId, requiredTemplate);

      const checked = await checkQuality(numbers, business.accessToken);
      // Fresh ratings are worth keeping — the app's cached qualityRating
      // otherwise only updates when someone clicks "Check Quality" or Meta
      // happens to fire a quality webhook, so it drifts for weeks.
      await persistQuality(business, checked);

      const eligible: Candidate[] = [];
      for (const c of checked) {
        if (c.status !== "CONNECTED") continue; // PENDING numbers fail 133010 on every send
        if (!approvedOn.has(c.phoneNumberId)) continue; // missing template fails 132001
        eligible.push({
          businessId: business.businessId,
          phoneNumberId: c.phoneNumberId,
          displayNumber: c.displayNumber,
          quality: c.quality,
        });
      }

      const degraded = eligible.filter((c) => DEGRADED.has(c.quality));
      const green = eligible.filter((c) => !DEGRADED.has(c.quality));
      totalDegraded += degraded.length;
      totalGreen += green.length;

      console.log(
        `${business.businessId}: ${numbers.length} numbers -> ${eligible.length} eligible ` +
          `(${degraded.length} degraded, ${green.length} green), template=${requiredTemplate}`
      );

      pool[business.businessId] = {
        template: requiredTemplate,
        lang,
        numbers: degraded.map((c) => c.phoneNumberId),
        // green kept aside below, only used to satisfy MIN_POOL
      };
      (pool[business.businessId] as unknown as { _green: string[] })._green = green.map((c) => c.phoneNumberId);
    }

    // Top up to MIN_POOL with GREEN numbers if there aren't enough degraded
    // ones — a pool below the floor risks the signup flow going quiet.
    let poolSize = Object.values(pool).reduce((n, p) => n + p.numbers.length, 0);
    if (poolSize < MIN_POOL) {
      for (const cfg of Object.values(pool)) {
        const greens = (cfg as unknown as { _green: string[] })._green || [];
        while (poolSize < MIN_POOL && greens.length > 0) {
          cfg.numbers.push(greens.shift()!);
          poolSize++;
        }
        if (poolSize >= MIN_POOL) break;
      }
      console.log(`Topped pool up to ${poolSize} with green numbers (floor is ${MIN_POOL})`);
    }

    for (const cfg of Object.values(pool)) {
      delete (cfg as unknown as { _green?: string[] })._green;
    }
    for (const [key, cfg] of Object.entries(pool)) {
      if (cfg.numbers.length === 0) delete pool[key];
    }

    if (poolSize === 0) {
      console.error("No eligible numbers at all — leaving existing config untouched");
      return;
    }

    // The dead WA_SENDERS_JSON predates this and is never read by the target
    // function; dropping it reclaims ~1KB of the 4KB env budget.
    delete env.WA_SENDERS_JSON;

    let poolJson = JSON.stringify(pool);
    env.WA_SENDER_POOL = poolJson;
    if (envSize(env) > ENV_BUDGET_BYTES) {
      trimToBudget(pool, env);
      poolJson = JSON.stringify(pool);
      env.WA_SENDER_POOL = poolJson;
      poolSize = Object.values(pool).reduce((n, p) => n + p.numbers.length, 0);
      console.log(`Trimmed pool to ${poolSize} numbers to fit the env var budget`);
    }

    await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: TARGET_FUNCTION,
        Environment: { Variables: env },
      })
    );

    console.log(
      `Rotation complete: ${poolSize} numbers across ${Object.keys(pool).length} business(es) ` +
        `(${totalDegraded} degraded / ${totalGreen} green eligible), env=${envSize(env)}B`
    );
  } catch (err) {
    console.error("Number rotation error:", err);
  }
};

function envSize(env: Record<string, string>): number {
  return Object.entries(env).reduce((n, [k, v]) => n + k.length + (v || "").length, 0);
}

/** Drops numbers (last business first) until the env fits under budget. */
function trimToBudget(pool: Record<string, { numbers: string[] }>, env: Record<string, string>): void {
  const keys = Object.keys(pool);
  while (keys.length > 0) {
    const key = keys[keys.length - 1];
    const cfg = pool[key];
    if (!cfg || cfg.numbers.length <= 1) {
      keys.pop();
      continue;
    }
    cfg.numbers.pop();
    env.WA_SENDER_POOL = JSON.stringify(pool);
    if (envSize(env) <= ENV_BUDGET_BYTES) return;
  }
}

/** phoneNumberIds of this business that have `templateName` approved. */
async function numbersWithTemplate(businessId: string, templateName: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLES.TEMPLATES,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": `BIZ#${businessId}`, ":prefix": `TPL#` },
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of res.Items || []) {
      if (item.templateName !== templateName) continue;
      if ((item.status || "").toLowerCase() !== "approved") continue;
      ids.add((item.SK as string).split("#")[1]);
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return ids;
}

interface Checked {
  phoneNumberId: string;
  displayNumber: string;
  quality: string;
  status: string;
}

/** Live quality + connection status per number, 10 at a time. */
async function checkQuality(numbers: PhoneNumber[], accessToken: string): Promise<Checked[]> {
  const out: Checked[] = [];
  const CONCURRENCY = 10;
  for (let i = 0; i < numbers.length; i += CONCURRENCY) {
    const slice = numbers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (pn) => {
        try {
          const res = await fetch(
            `https://graph.facebook.com/v25.0/${pn.phoneNumberId}?fields=quality_rating,status`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const data = (await res.json()) as { quality_rating?: string; status?: string };
          return {
            phoneNumberId: pn.phoneNumberId,
            displayNumber: pn.displayNumber,
            quality: data.quality_rating || "UNKNOWN",
            // Unreadable status means "don't trust it" — treated as not
            // CONNECTED so a number is left out rather than wrongly used.
            status: data.status || "",
          };
        } catch (err) {
          console.error(`Quality check failed for ${pn.phoneNumberId}:`, err);
          return { phoneNumberId: pn.phoneNumberId, displayNumber: pn.displayNumber, quality: "UNKNOWN", status: "" };
        }
      })
    );
    out.push(...results);
  }
  return out;
}

async function persistQuality(business: BusinessRecord, checked: Checked[]): Promise<void> {
  const byId = new Map(checked.map((c) => [c.phoneNumberId, c]));
  const updated = (business.phoneNumbers || []).map((pn) => {
    const c = byId.get(pn.phoneNumberId);
    return c ? { ...pn, qualityRating: c.quality } : pn;
  });
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.BUSINESSES,
        Key: { PK: business.PK, SK: business.SK },
        UpdateExpression: "SET phoneNumbers = :n, updatedAt = :now",
        ExpressionAttributeValues: { ":n": updated, ":now": new Date().toISOString() },
      })
    );
  } catch (err) {
    // Cache refresh is a bonus, not the job — never let it stop the rotation.
    console.error(`Failed to persist quality for ${business.businessId}:`, err);
  }
}
