import { estimateCapacity, DEFAULT_SAFE_MSGS_PER_SECOND } from "../capacity";

describe("estimateCapacity — time math", () => {
  it("matches the documented 6000-contacts/4-numbers example (5 minutes at 5/sec)", () => {
    const result = estimateCapacity(6000, [{}, {}, {}, {}]);
    // 6000 / (5 * 4 * 60) = 5 min
    expect(result.estimatedMinutes).toBeCloseTo(6000 / (DEFAULT_SAFE_MSGS_PER_SECOND * 4 * 60), 2);
  });

  it("returns 0 minutes for zero contacts", () => {
    expect(estimateCapacity(0, [{}, {}]).estimatedMinutes).toBe(0);
  });

  it("returns 0 minutes when no numbers are given (rather than dividing by zero)", () => {
    expect(estimateCapacity(1000, []).estimatedMinutes).toBe(0);
  });

  it("respects a custom safe pace", () => {
    const result = estimateCapacity(900, [{}], { safeMsgsPerSecondPerNumber: 1 });
    expect(result.estimatedMinutes).toBeCloseTo(15, 2); // 900 contacts at 60/min = 15 min
  });
});

describe("estimateCapacity — numbers needed for a target delivery time", () => {
  it("computes the 6000-contacts/5-minutes example → 4 numbers", () => {
    const result = estimateCapacity(6000, [], { targetMinutes: 5 });
    // ceil(6000 / (5 * 5 * 60)) = ceil(6000/1500) = 4
    expect(result.numbersNeededForTarget).toBe(4);
  });

  it("never recommends fewer than 1 number", () => {
    const result = estimateCapacity(1, [], { targetMinutes: 1000 });
    expect(result.numbersNeededForTarget).toBe(1);
  });

  it("omits numbersNeededForTarget when no target is given", () => {
    expect(estimateCapacity(6000, [{}, {}]).numbersNeededForTarget).toBeUndefined();
  });
});

describe("estimateCapacity — aggregate 24h volume/health check", () => {
  it("sums known tier caps", () => {
    const result = estimateCapacity(500, [{ messagingLimit: "TIER_250" }, { messagingLimit: "TIER_250" }]);
    expect(result.aggregateDailyCapacity).toBe(500);
    expect(result.exceedsAggregateCapacity).toBe(false);
  });

  it("flags when contacts exceed the aggregate safe daily capacity", () => {
    const result = estimateCapacity(600, [{ messagingLimit: "TIER_250" }, { messagingLimit: "TIER_250" }]);
    expect(result.exceedsAggregateCapacity).toBe(true);
  });

  it("treats a number with no cached tier conservatively (TIER_50), not as unconstrained", () => {
    const result = estimateCapacity(100, [{}]); // no messagingLimit at all
    expect(result.aggregateDailyCapacity).toBe(50);
    expect(result.exceedsAggregateCapacity).toBe(true);
  });

  it("treats TIER_UNLIMITED as effectively unbounded", () => {
    const result = estimateCapacity(1_000_000, [{ messagingLimit: "TIER_UNLIMITED" }]);
    expect(result.exceedsAggregateCapacity).toBe(false);
  });
});
