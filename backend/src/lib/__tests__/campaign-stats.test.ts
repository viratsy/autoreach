import { applyStats, CounterBatch, COUNTER_FIELDS } from "../campaign-stats";

describe("applyStats", () => {
  it("adds the STATS deltas onto whatever METADATA already held", () => {
    const campaign: Record<string, unknown> = { sentCount: 100, deliveredCount: 80 };
    applyStats(campaign, { sentCount: 25, deliveredCount: 10 });
    expect(campaign.sentCount).toBe(125);
    expect(campaign.deliveredCount).toBe(90);
  });

  it("leaves a pre-cutover campaign untouched when it has no STATS item", () => {
    const campaign: Record<string, unknown> = { sentCount: 100, deliveredCount: 80 };
    applyStats(campaign, null);
    expect(campaign).toEqual({ sentCount: 100, deliveredCount: 80 });
  });

  it("treats a missing METADATA counter as zero, for campaigns created after the cutover", () => {
    const campaign: Record<string, unknown> = {};
    applyStats(campaign, { sentCount: 42 });
    expect(campaign.sentCount).toBe(42);
  });

  // get.ts only takes its cheap counter-based path when sentCount AND
  // deliveredCount are both non-null; leaving either undefined sends it off to
  // scan every message row in the campaign instead.
  it("defines every counter once a STATS item exists, even the zero ones", () => {
    const campaign: Record<string, unknown> = {};
    applyStats(campaign, { sentCount: 5 });
    for (const field of COUNTER_FIELDS) {
      expect(typeof campaign[field]).toBe("number");
    }
    expect(campaign.deliveredCount).toBe(0);
  });
});

describe("CounterBatch", () => {
  it("collapses many events for one campaign into a single delta", () => {
    const batch = new CounterBatch();
    for (let i = 0; i < 28; i++) batch.add("camp1", "deliveredCount");
    for (let i = 0; i < 3; i++) batch.add("camp1", "readCount");

    expect(batch.size).toBe(1);
    expect(batch.pending()).toEqual([["camp1", { deliveredCount: 28, readCount: 3 }]]);
  });

  // The async-failure path credits failedCount and takes the message back out
  // of whichever stage it had reached. Both can land in the same batch, so the
  // tally has to net them rather than counting events.
  it("nets signed deltas so a delivered-then-failed message cancels out", () => {
    const batch = new CounterBatch();
    batch.add("camp1", "deliveredCount", 1);
    batch.add("camp1", "deliveredCount", 1);
    batch.add("camp1", "failedCount", 1);
    batch.add("camp1", "deliveredCount", -1);

    expect(batch.pending()).toEqual([["camp1", { deliveredCount: 1, failedCount: 1 }]]);
  });

  it("keeps campaigns separate when one batch spans several", () => {
    const batch = new CounterBatch();
    batch.add("camp1", "sentCount");
    batch.add("camp2", "sentCount");
    batch.add("camp2", "sentCount");

    expect(batch.size).toBe(2);
    expect(Object.fromEntries(batch.pending())).toEqual({
      camp1: { sentCount: 1 },
      camp2: { sentCount: 2 },
    });
  });
});
