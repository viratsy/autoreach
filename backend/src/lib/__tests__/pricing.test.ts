import { estimateCost, calculateActualCost, PRICING_INR } from "../pricing";

describe("estimateCost", () => {
  it("uses the marketing rate for marketing category", () => {
    const result = estimateCost(1000, "MARKETING");
    expect(result.perMessage).toBe(PRICING_INR.marketing);
    expect(result.total).toBe(863.1);
    expect(result.currency).toBe("INR");
  });

  it("uses the utility rate for utility category", () => {
    const result = estimateCost(1000, "UTILITY");
    expect(result.perMessage).toBe(PRICING_INR.utility);
    expect(result.total).toBe(115);
  });

  it("is case-insensitive on category", () => {
    expect(estimateCost(100, "Marketing").perMessage).toBe(PRICING_INR.marketing);
  });

  it("falls back to utility rate for an unrecognized category", () => {
    expect(estimateCost(100, "something_else").perMessage).toBe(PRICING_INR.utility);
  });

  it("returns zero cost for zero contacts", () => {
    expect(estimateCost(0, "utility").total).toBe(0);
  });
});

describe("calculateActualCost", () => {
  it("prices only delivered messages, not total contacts", () => {
    const result = calculateActualCost(500, "utility");
    expect(result.total).toBe(57.5);
  });

  it("service category is free", () => {
    expect(calculateActualCost(1000, "service").total).toBe(0);
  });
});
