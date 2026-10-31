import { computeAggregatesFresh, writeCachedAggregates } from "../../lib/campaign-aggregates";

/**
 * Recomputes the campaigns dashboard aggregates on a schedule and caches them.
 *
 * These totals used to be derived from a full table read on EVERY campaigns-
 * list request — the single biggest reason that endpoint measured 17s average
 * against a 20s API Gateway ceiling. They cover every campaign ever created,
 * so they cannot be narrowed by pagination; but they also change only as
 * campaigns send, so computing them every few minutes instead of per request
 * costs nothing anyone can perceive on a trend chart.
 *
 * list.ts falls back to computing them inline when this cache is missing or
 * older than AGG_MAX_AGE_MS, so a failure here degrades the list to its
 * previous speed rather than showing wrong or empty numbers.
 */
export const handler = async () => {
  const started = Date.now();
  try {
    const { aggregates, items } = await computeAggregatesFresh();
    await writeCachedAggregates(aggregates);
    console.log(
      `[aggregates] refreshed from ${items.length} campaigns in ${Date.now() - started}ms ` +
        `(scheduled=${aggregates.scheduled} running=${aggregates.running} completed=${aggregates.completed})`
    );
  } catch (err) {
    // Never throw: a failed refresh must not retry-storm the table. The list
    // endpoint notices the stale timestamp and recomputes inline.
    console.error("[aggregates] refresh failed", err);
  }
};
