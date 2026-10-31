import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { applyStats, fetchStatsMap } from "../../lib/campaign-stats";
import {
  LIST_PROJECTION,
  computeAggregates,
  readCachedAggregates,
  scanAllCampaigns,
  writeCachedAggregates,
  type CampaignAggregates,
  type Item,
} from "../../lib/campaign-aggregates";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { calculateActualCost } from "../../lib/pricing";

type SortKey = "campaignName" | "businessName" | "created" | "schedule" | "status" | "totalContacts" | "sent" | "delivered" | "read" | "replies";

/** Every status a campaign record can carry, for the per-status GSI2 queries. */
const ALL_STATUSES = ["draft", "scheduled", "running", "completed", "cancelled", "failed"];

// Drafts have no scheduleDate — fall back to creation date, same convention
// the frontend used before this filtering moved server-side.
function campaignDate(c: Item): string {
  return (c.scheduleDate as string) || ((c.createdAt as string) || "").slice(0, 10);
}

function sortValue(c: Item, key: SortKey): string | number {
  switch (key) {
    case "campaignName": return ((c.campaignName as string) || "").toLowerCase();
    case "businessName": return ((c.businessName as string) || "").toLowerCase();
    case "created": return (c.createdAt as string) || "";
    case "schedule": return `${campaignDate(c)} ${(c.scheduleTime as string) || ""}`;
    case "status": return (c.status as string) || "";
    case "totalContacts": return (c.totalContacts as number) || 0;
    case "sent": return (c.sentCount as number) || 0;
    case "delivered": return (c.deliveredCount as number) || 0;
    case "read": return (c.readCount as number) || 0;
    case "replies": return (c.repliedCount as number) || 0;
  }
}

function toRow(item: Item) {
  return {
    campaignId: item.campaignId,
    campaignName: item.campaignName,
    businessId: item.businessId,
    businessName: item.businessName,
    templateName: item.templateName,
    templateCategory: item.templateCategory || "UTILITY",
    totalContacts: item.totalContacts,
    scheduleDate: item.scheduleDate,
    scheduleTime: item.scheduleTime,
    status: item.status,
    createdAt: item.createdAt,
    sentCount: item.sentCount || 0,
    deliveredCount: item.deliveredCount || 0,
    readCount: item.readCount || 0,
    repliedCount: item.repliedCount || 0,
    failedCount: item.failedCount || 0,
    skippedCount: item.skippedCount || 0,
    estimatedCost: item.estimatedCost || null,
    respectUnsubscribeList: item.respectUnsubscribeList !== false,
    excludePaidUsers: item.excludePaidUsers !== false,
    numberCount: Array.isArray(item.selectedNumbers) ? item.selectedNumbers.length : 0,
    actualCost: calculateActualCost((item.deliveredCount as number) || 0, (item.templateCategory as string) || "utility"),
  };
}

/**
 * Pulls the newest `want` campaigns for one status straight off GSI2, whose
 * sort key is `scheduleDate#scheduleTime`. Paginates only until enough rows
 * are in hand, so a 2,800-campaign status costs one small query rather than a
 * full partition read.
 */
async function queryStatus(status: string, want: number, ascending: boolean): Promise<Item[]> {
  const out: Item[] = [];
  let lastKey: Item | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLES.CAMPAIGNS,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": `STATUS#${status}` },
        ExpressionAttributeNames: { "#status": "status" },
        ProjectionExpression: LIST_PROJECTION,
        ScanIndexForward: ascending,
        Limit: Math.max(want - out.length, 1),
        ExclusiveStartKey: lastKey,
      })
    );
    out.push(...((res.Items || []) as Item[]));
    lastKey = res.LastEvaluatedKey as Item | undefined;
  } while (lastKey && out.length < want);
  return out;
}

/**
 * List campaigns — paginated, filterable, sortable table rows, plus the
 * dashboard-wide aggregates (which always cover every campaign, regardless of
 * the page or filters currently shown).
 *
 * Two paths:
 *
 *  FAST — the default view (sorted by schedule, no search, no date range).
 *  Reads only the rows the page needs via GSI2, and the aggregates from the
 *  cache that aggregate-refresh.ts keeps warm. A couple of small queries.
 *
 *  FULL — any sort by a counter, or a search/date filter, both of which have
 *  to consider every campaign before page 1 can be chosen. Falls back to the
 *  parallel projected scan.
 *
 * GET /campaigns?page=1&limit=20&status=scheduled&search=x&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&sortKey=schedule&sortDir=desc
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const qs = event.queryStringParameters || {};
    const page = Math.max(1, parseInt(qs.page || "1") || 1);
    const limit = Math.min(500, Math.max(1, parseInt(qs.limit || "20") || 20));
    const statusFilter = qs.status && qs.status !== "all" ? qs.status : null;
    const search = (qs.search || "").trim().toLowerCase();
    const dateFrom = qs.dateFrom || "";
    const dateTo = qs.dateTo || "";
    const sortKey = (qs.sortKey as SortKey) || "schedule";
    const sortDir = qs.sortDir === "asc" ? "asc" : "desc";

    const cached = await readCachedAggregates();

    // A counter sort has to rank every campaign by a value that lives on the
    // STATS sibling, and search/date filters can match anything anywhere — so
    // neither can be answered from the top of an index.
    const canUseFastPath =
      Boolean(cached) && sortKey === "schedule" && !search && !dateFrom && !dateTo;

    let pageCampaigns: ReturnType<typeof toRow>[];
    let totalCount: number;
    let aggregates: CampaignAggregates;

    if (canUseFastPath) {
      aggregates = cached as CampaignAggregates;
      const statuses = statusFilter ? [statusFilter] : ALL_STATUSES;
      const need = page * limit;

      const perStatus = await Promise.all(
        statuses.map(async (st) => {
          // Drafts are the one status whose GSI2 order can disagree with the
          // comparator: 9 of them carry no scheduleDate, so their GSI2SK is
          // empty and sorts at one end while campaignDate() ranks them by
          // createdAt. There are only ~100 drafts, so take them all and let
          // the merge below order them properly.
          const want = st === "draft" ? 1000 : need;
          return queryStatus(st, want, sortDir === "asc");
        })
      );
      const merged = perStatus.flat();

      merged.sort((a, b) => {
        const va = sortValue(a, sortKey);
        const vb = sortValue(b, sortKey);
        const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
        return sortDir === "asc" ? cmp : -cmp;
      });

      const slice = merged.slice((page - 1) * limit, page * limit);

      // Counters for the rows on screen only — ~1 BatchGet instead of ~31.
      const statsMap = await fetchStatsMap(slice.map((i) => i.campaignId as string));
      for (const item of slice) applyStats(item, statsMap.get(item.campaignId as string));

      pageCampaigns = slice.map(toRow);
      totalCount = statusFilter
        ? aggregates.statusCounts?.[statusFilter] || 0
        : Object.values(aggregates.statusCounts || {}).reduce((a, b) => a + b, 0);
    } else {
      const items = await scanAllCampaigns();
      const statsMap = await fetchStatsMap(items.map((i) => i.campaignId as string));
      for (const item of items) applyStats(item, statsMap.get(item.campaignId as string));

      // Recompute and refresh the cache while the data is already in hand —
      // a cold cache repairs itself on the first request rather than waiting
      // for the scheduled refresher.
      aggregates = cached || computeAggregates(items);
      if (!cached) {
        writeCachedAggregates(aggregates).catch((err) =>
          console.error("[aggregates] opportunistic cache write failed", err)
        );
      }

      const filteredSorted = items
        .filter((c) => !statusFilter || c.status === statusFilter)
        .filter((c) => !search || ((c.campaignName as string) || "").toLowerCase().includes(search))
        .filter((c) => !dateFrom || campaignDate(c) >= dateFrom)
        .filter((c) => !dateTo || campaignDate(c) <= dateTo)
        .sort((a, b) => {
          const va = sortValue(a, sortKey);
          const vb = sortValue(b, sortKey);
          const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
          return sortDir === "asc" ? cmp : -cmp;
        });

      totalCount = filteredSorted.length;
      pageCampaigns = filteredSorted.slice((page - 1) * limit, page * limit).map(toRow);
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    return success(
      {
        campaigns: pageCampaigns,
        totalCount,
        page,
        limit,
        totalPages,
        // Identical shape to before the aggregates moved out of this handler.
        stats: {
          totalCampaigns: aggregates.totalCampaigns,
          scheduled: aggregates.scheduled,
          running: aggregates.running,
          completed: aggregates.completed,
          failed: aggregates.failed,
          messageVolume: aggregates.messageVolume,
          previousMessageVolume: aggregates.previousMessageVolume,
          breakdownTotals: aggregates.breakdownTotals,
          dailyBreakdown: aggregates.dailyBreakdown,
          topTemplates: aggregates.topTemplates,
        },
      },
      origin
    );
  } catch (err) {
    console.error("List campaigns error:", err);
    return error(500, "Failed to list campaigns", origin);
  }
};
