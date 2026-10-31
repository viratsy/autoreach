import { UpdateCommand, GetCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "./dynamo";

/**
 * Campaign funnel counters, kept in a sibling item rather than on the campaign
 * record itself.
 *
 * Why: DynamoDB bills a write by the size of the WHOLE item, rounded up to the
 * next KB, and again for every index that projects it. The CAMP#<id>/METADATA
 * record carries the full campaign config (parameterMapping, templateMappings,
 * selectedNumbers, csvS3Key...) and averages ~3.8KB, with GSI1 and GSI2 both
 * projecting ALL. So `ADD deliveredCount :one` on it cost 4 + 4 + 4 = 12 write
 * units to change one integer — measured at $116/month across both accounts for
 * a table holding 10MB of data.
 *
 * CAMP#<id>/STATS holds nothing but the counters (~150 bytes) and carries no
 * GSI key attributes, so the indexes are sparse and skip it entirely: 1 write
 * unit instead of 12.
 *
 * Migration: STATS holds the deltas accrued SINCE the cutover, and readers add
 * it to whatever METADATA already had. That means no backfill and no window
 * where a campaign reports the wrong number — campaigns finished before the
 * cutover have no STATS item and read exactly as they always did, campaigns
 * running across it get the frozen METADATA value plus everything since.
 */

export const STATS_SK = "STATS";

export const COUNTER_FIELDS = [
  "sentCount",
  "deliveredCount",
  "readCount",
  "repliedCount",
  "failedCount",
  "skippedCount",
  // Email half of the same campaign. Kept on the same STATS item so one read
  // gets both channels, and so email counters inherit the cheap-write property
  // that moving these off the campaign record bought.
  "emailSentCount",
  "emailDeliveredCount",
  "emailFailedCount",
  "emailSkippedCount",
  "emailBouncedCount",
  "emailComplainedCount",
  // Opens are inflated by Apple Mail Privacy Protection and Gmail image
  // proxying, which fetch the pixel without a human reading anything. Kept
  // as a trend signal; clicks are the number that means something.
  "emailOpenedCount",
  "emailClickedCount",
] as const;

export type CounterField = (typeof COUNTER_FIELDS)[number];

/** Signed deltas — the failure path decrements delivered/read as it increments failed. */
export type CounterDeltas = Partial<Record<CounterField, number>>;

type Item = Record<string, unknown>;

/**
 * Folds a STATS item into a campaign record in place, so everything downstream
 * can keep reading `campaign.sentCount` without knowing the split exists.
 */
export function applyStats(campaign: Item, stats?: Item | null): Item {
  if (!stats) return campaign;
  // Every field is set, not just the non-zero ones. get.ts takes its fast path
  // only when sentCount and deliveredCount are both non-null — a campaign that
  // has started sending but had nothing delivered yet would otherwise leave
  // deliveredCount undefined and fall through to a full scan of its messages.
  for (const field of COUNTER_FIELDS) {
    campaign[field] = ((campaign[field] as number) || 0) + ((stats[field] as number) || 0);
  }
  return campaign;
}

/** Reads one campaign's STATS item. Returns null when it has none yet. */
export async function fetchStats(campaignId: string): Promise<Item | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: TABLES.CAMPAIGNS,
      Key: { PK: `CAMP#${campaignId}`, SK: STATS_SK },
    })
  );
  return (res.Item as Item) || null;
}

/**
 * Reads STATS for many campaigns at once, keyed by campaignId. Used by the list
 * endpoints so showing 50 campaigns stays one round trip, not 50.
 */
export async function fetchStatsMap(campaignIds: string[]): Promise<Map<string, Item>> {
  const out = new Map<string, Item>();
  const unique = [...new Set(campaignIds)].filter(Boolean);
  if (!unique.length) return out;

  // BatchGetItem takes at most 100 keys per call. The chunks are independent,
  // so they run concurrently: the campaigns list asks for ~3,000 ids, which is
  // ~31 calls — serially that was ~31 round trips of pure latency on an
  // endpoint already measured at 17s.
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const found: Item[] = [];
      let keys = chunk.map((id) => ({ PK: `CAMP#${id}`, SK: STATS_SK }));

      // A batch can come back partially unprocessed under throttling; the
      // leftovers have to be re-requested or those campaigns silently show
      // stale counters. Retried per chunk so one throttled chunk cannot hold
      // up the others.
      let attempts = 0;
      while (keys.length && attempts < 5) {
        const res = await docClient.send(
          new BatchGetCommand({ RequestItems: { [TABLES.CAMPAIGNS]: { Keys: keys } } })
        );
        found.push(...((res.Responses?.[TABLES.CAMPAIGNS] || []) as Item[]));
        keys = (res.UnprocessedKeys?.[TABLES.CAMPAIGNS]?.Keys || []) as typeof keys;
        attempts++;
      }
      return found;
    })
  );

  for (const item of results.flat()) {
    const pk = item.PK as string;
    out.set(pk.replace("CAMP#", ""), item);
  }
  return out;
}

/**
 * Applies counter deltas to a campaign's STATS item, creating it on first use
 * (ADD on a missing item starts from zero).
 *
 * Callers should aggregate in memory and call this once per campaign per batch
 * rather than once per message — a campaign's webhooks arrive together, so a
 * single Lambda invocation would otherwise write the same item dozens of times.
 */
export async function addCounters(campaignId: string, deltas: CounterDeltas): Promise<void> {
  const entries = Object.entries(deltas).filter(([, v]) => typeof v === "number" && v !== 0);
  if (!entries.length) return;

  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };
  const adds: string[] = [];

  entries.forEach(([field, delta], i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = delta;
    adds.push(`#f${i} :v${i}`);
  });

  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.CAMPAIGNS,
      Key: { PK: `CAMP#${campaignId}`, SK: STATS_SK },
      UpdateExpression: `SET #updatedAt = :now ADD ${adds.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

/** In-memory tally so one invocation writes each campaign's counters once. */
export class CounterBatch {
  private byCampaign = new Map<string, CounterDeltas>();

  add(campaignId: string, field: CounterField, delta = 1) {
    const deltas = this.byCampaign.get(campaignId) || {};
    deltas[field] = (deltas[field] || 0) + delta;
    this.byCampaign.set(campaignId, deltas);
  }

  get size() {
    return this.byCampaign.size;
  }

  /** The netted deltas accumulated so far, for logging and tests. */
  pending(): [string, CounterDeltas][] {
    return [...this.byCampaign.entries()];
  }

  /**
   * Writes every tallied campaign. One campaign's write failing must not drop
   * the others, so failures are logged per campaign rather than thrown — a lost
   * counter is a cosmetic stat, and throwing here would send the whole SQS batch
   * back for redelivery and double-count everything that already succeeded.
   */
  async flush(): Promise<void> {
    const pending = [...this.byCampaign.entries()];
    this.byCampaign.clear();
    await Promise.all(
      pending.map(([campaignId, deltas]) =>
        addCounters(campaignId, deltas).catch((err) =>
          console.error(`[counters] flush failed for ${campaignId}:`, err)
        )
      )
    );
  }
}
