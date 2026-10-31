import { ScanCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "./dynamo";
import { applyStats, fetchStatsMap } from "./campaign-stats";

/**
 * The dashboard aggregates that used to be recomputed, from every campaign in
 * the table, on every single campaigns-list request.
 *
 * They legitimately need the whole table — they are totals across all
 * campaigns, unaffected by the table's pagination or filters. What they do NOT
 * need is to be recomputed per request: they move only as campaigns send, and
 * a few minutes of staleness on a trend chart is invisible. So a scheduled job
 * computes them and stores one item; the list endpoint reads that item.
 *
 * list.ts keeps an inline fallback for when the cache is missing or stale, so
 * a failed refresher degrades to "slower" rather than "wrong".
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const AGG_PK = "AGG#campaigns";
// Deliberately NOT "METADATA": scanAllCampaigns filters on SK = "METADATA",
// so an aggregate item keyed that way would be scanned back in as if it were
// a campaign — inflating every count it is meant to report.
export const AGG_SK = "AGGREGATES";

/** How old a cached aggregate may be before list.ts recomputes it inline. */
export const AGG_MAX_AGE_MS = 15 * 60 * 1000;

export type Item = Record<string, unknown>;

interface Totals {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}
const emptyTotals = (): Totals => ({ sent: 0, delivered: 0, read: 0, replied: 0 });

interface BreakdownTotals extends Totals {
  failed: number;
  skipped: number;
  totalContacts: number;
}
const emptyBreakdownTotals = (): BreakdownTotals => ({ ...emptyTotals(), failed: 0, skipped: 0, totalContacts: 0 });

/** YYYY-MM-DD in IST, for bucketing a campaign's lifetime counters onto the
 * day it was created. */
function istDayKey(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** The ~18 fields the list and the aggregates actually read. An item averages
 * 5.2KB, of which selectedNumbers alone is 3.6KB — none of which is used here. */
export const LIST_PROJECTION = [
  "campaignId", "campaignName", "businessId", "businessName",
  "templateName", "templateCategory", "totalContacts",
  "scheduleDate", "scheduleTime", "#status", "createdAt", "estimatedCost",
  "sentCount", "deliveredCount", "readCount", "repliedCount",
  "failedCount", "skippedCount",
].join(", ");

const SCAN_SEGMENTS = 8;

/**
 * Every campaign METADATA item, projected and scanned in parallel segments.
 * A Scan's 1MB page limit is per request, so N concurrent segments turn N
 * sequential waits into one.
 */
export async function scanAllCampaigns(): Promise<Item[]> {
  const segments = await Promise.all(
    Array.from({ length: SCAN_SEGMENTS }, async (_, segment) => {
      const out: Item[] = [];
      let lastKey: Item | undefined;
      do {
        const result = await docClient.send(
          new ScanCommand({
            TableName: TABLES.CAMPAIGNS,
            Segment: segment,
            TotalSegments: SCAN_SEGMENTS,
            FilterExpression: "SK = :sk",
            ProjectionExpression: LIST_PROJECTION,
            // `status` is a DynamoDB reserved word.
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":sk": "METADATA" },
            ExclusiveStartKey: lastKey,
          })
        );
        out.push(...((result.Items || []) as Item[]));
        lastKey = result.LastEvaluatedKey as Item | undefined;
      } while (lastKey);
      return out;
    })
  );
  return segments.flat();
}

export interface CampaignAggregates {
  totalCampaigns: number;
  scheduled: number;
  running: number;
  completed: number;
  failed: number;
  messageVolume: Record<string, Totals>;
  previousMessageVolume: Record<string, Totals>;
  breakdownTotals: Record<string, BreakdownTotals>;
  dailyBreakdown: Record<string, { date: string; sent: number; delivered: number; read: number; replied: number }[]>;
  topTemplates: Record<string, { templateName: string; campaignCount: number; totalContacts: number; delivered: number; deliveryRate: number }[]>;
  /** Per-status counts, so the list can report totalCount without counting rows. */
  statusCounts: Record<string, number>;
}

/**
 * Reduces the full campaign set into the dashboard's stat blocks. Lifted
 * verbatim out of list.ts — same windows, same IST day boundaries, same
 * "bucket a campaign's lifetime counters onto its creation day" convention —
 * so the cached numbers are identical to what the inline version produced.
 */
export function computeAggregates(items: Item[]): CampaignAggregates {
  const now = Date.now();
  const nowIST = new Date(now + IST_OFFSET_MS);
  const istMidnightUTC = Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - IST_OFFSET_MS;

  const ranges: Record<string, { curLower: number; prevLower: number; prevUpper: number }> = {
    today: { curLower: istMidnightUTC, prevLower: istMidnightUTC - DAY_MS, prevUpper: istMidnightUTC },
    last7Days: { curLower: now - 7 * DAY_MS, prevLower: now - 14 * DAY_MS, prevUpper: now - 7 * DAY_MS },
    last15Days: { curLower: now - 15 * DAY_MS, prevLower: now - 30 * DAY_MS, prevUpper: now - 15 * DAY_MS },
    last30Days: { curLower: now - 30 * DAY_MS, prevLower: now - 60 * DAY_MS, prevUpper: now - 30 * DAY_MS },
  };

  const messageVolume: Record<string, Totals> = {};
  const previousMessageVolume: Record<string, Totals> = {};
  const breakdownTotals: Record<string, BreakdownTotals> = {};
  const dailyBreakdownMap: Record<string, Record<string, Totals>> = {};
  const templateAggMap: Record<string, Record<string, { campaignCount: number; totalContacts: number; delivered: number }>> = {};
  for (const key of Object.keys(ranges)) {
    messageVolume[key] = emptyTotals();
    previousMessageVolume[key] = emptyTotals();
    breakdownTotals[key] = emptyBreakdownTotals();
    dailyBreakdownMap[key] = {};
    templateAggMap[key] = {};
  }

  const statusCounts: Record<string, number> = {};

  for (const item of items) {
    const status = (item.status as string) || "unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    const createdAtMs = new Date(item.createdAt as string).getTime();
    const sent = (item.sentCount as number) || 0;
    const delivered = (item.deliveredCount as number) || 0;
    const read = (item.readCount as number) || 0;
    const replied = (item.repliedCount as number) || 0;
    const failed = (item.failedCount as number) || 0;
    const skipped = (item.skippedCount as number) || 0;
    const dayKey = istDayKey(createdAtMs);
    const templateName = (item.templateName as string) || "(no template)";
    const totalContacts = (item.totalContacts as number) || 0;

    for (const [key, range] of Object.entries(ranges)) {
      if (createdAtMs >= range.curLower) {
        messageVolume[key].sent += sent;
        messageVolume[key].delivered += delivered;
        messageVolume[key].read += read;
        messageVolume[key].replied += replied;

        breakdownTotals[key].sent += sent;
        breakdownTotals[key].delivered += delivered;
        breakdownTotals[key].read += read;
        breakdownTotals[key].replied += replied;
        breakdownTotals[key].failed += failed;
        breakdownTotals[key].skipped += skipped;
        breakdownTotals[key].totalContacts += totalContacts;

        if (!dailyBreakdownMap[key][dayKey]) dailyBreakdownMap[key][dayKey] = emptyTotals();
        dailyBreakdownMap[key][dayKey].sent += sent;
        dailyBreakdownMap[key][dayKey].delivered += delivered;
        dailyBreakdownMap[key][dayKey].read += read;
        dailyBreakdownMap[key][dayKey].replied += replied;

        if (!templateAggMap[key][templateName]) {
          templateAggMap[key][templateName] = { campaignCount: 0, totalContacts: 0, delivered: 0 };
        }
        templateAggMap[key][templateName].campaignCount += 1;
        templateAggMap[key][templateName].totalContacts += totalContacts;
        templateAggMap[key][templateName].delivered += delivered;
      } else if (createdAtMs >= range.prevLower && createdAtMs < range.prevUpper) {
        previousMessageVolume[key].sent += sent;
        previousMessageVolume[key].delivered += delivered;
        previousMessageVolume[key].read += read;
        previousMessageVolume[key].replied += replied;
      }
    }
  }

  const dailyBreakdown: CampaignAggregates["dailyBreakdown"] = {};
  for (const [key, byDay] of Object.entries(dailyBreakdownMap)) {
    dailyBreakdown[key] = Object.entries(byDay)
      .map(([date, t]) => ({ date, ...t }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  const topTemplates: CampaignAggregates["topTemplates"] = {};
  for (const [key, byTemplate] of Object.entries(templateAggMap)) {
    topTemplates[key] = Object.entries(byTemplate)
      .map(([templateName, agg]) => ({
        templateName,
        ...agg,
        deliveryRate: agg.totalContacts > 0 ? agg.delivered / agg.totalContacts : 0,
      }))
      .sort((a, b) => b.totalContacts - a.totalContacts)
      .slice(0, 3);
  }

  return {
    totalCampaigns: items.length,
    scheduled: statusCounts.scheduled || 0,
    running: statusCounts.running || 0,
    completed: statusCounts.completed || 0,
    failed: statusCounts.failed || 0,
    messageVolume,
    previousMessageVolume,
    breakdownTotals,
    dailyBreakdown,
    topTemplates,
    statusCounts,
  };
}

/** Scan + fold in STATS siblings + reduce. The expensive path, used by the
 *  refresher and by list.ts's fallback. */
export async function computeAggregatesFresh(): Promise<{ aggregates: CampaignAggregates; items: Item[] }> {
  const items = await scanAllCampaigns();
  const statsMap = await fetchStatsMap(items.map((i) => i.campaignId as string));
  for (const item of items) applyStats(item, statsMap.get(item.campaignId as string));
  return { aggregates: computeAggregates(items), items };
}

export async function writeCachedAggregates(aggregates: CampaignAggregates): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLES.CAMPAIGNS,
      Item: { PK: AGG_PK, SK: AGG_SK, aggregates, computedAt: new Date().toISOString() },
    })
  );
}

/** Returns the cached block, or null when it is absent or too old to trust. */
export async function readCachedAggregates(): Promise<CampaignAggregates | null> {
  try {
    const res = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: AGG_PK, SK: AGG_SK } })
    );
    const item = res.Item;
    if (!item?.aggregates || !item.computedAt) return null;
    const age = Date.now() - new Date(item.computedAt as string).getTime();
    if (age > AGG_MAX_AGE_MS) return null;
    return item.aggregates as unknown as CampaignAggregates;
  } catch (err) {
    console.error("[aggregates] cache read failed", err);
    return null;
  }
}
