import {
  distributeContacts,
  getDistributionSummary,
  filterHealthyNumbers,
  distributeContactsWeighted,
} from "../round-robin";
import { PhoneNumber, CSVContact } from "../types";

function makeNumber(phoneNumberId: string, extra: Partial<PhoneNumber> = {}): PhoneNumber {
  return { phoneNumberId, displayNumber: phoneNumberId, displayName: phoneNumberId, ...extra };
}

function makeContacts(count: number): CSVContact[] {
  return Array.from({ length: count }, (_, i) => ({ phone: `9190000${i}` }));
}

describe("distributeContacts", () => {
  it("splits contacts evenly round-robin across numbers", () => {
    const numbers = [makeNumber("A"), makeNumber("B"), makeNumber("C")];
    const contacts = makeContacts(10);
    const result = distributeContacts(contacts, numbers);

    const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
    result.forEach((r) => { counts[r.assignedNumber.phoneNumberId]++; });
    expect(counts).toEqual({ A: 4, B: 3, C: 3 });
  });

  it("throws when no numbers are given", () => {
    expect(() => distributeContacts(makeContacts(1), [])).toThrow();
  });
});

describe("getDistributionSummary", () => {
  it("distributes the remainder to the first numbers", () => {
    const numbers = [makeNumber("A"), makeNumber("B"), makeNumber("C")];
    const summary = getDistributionSummary(10, numbers);
    expect(summary.map((s) => s.count)).toEqual([4, 3, 3]);
  });
});

describe("filterHealthyNumbers", () => {
  it("drops RED-quality numbers when a healthy alternative exists", () => {
    const numbers = [
      makeNumber("A", { qualityRating: "GREEN" }),
      makeNumber("B", { qualityRating: "RED" }),
    ];
    const result = filterHealthyNumbers(numbers);
    expect(result.map((n) => n.phoneNumberId)).toEqual(["A"]);
  });

  it("never returns an empty list even if all numbers are RED", () => {
    const numbers = [makeNumber("A", { qualityRating: "RED" }), makeNumber("B", { qualityRating: "RED" })];
    expect(filterHealthyNumbers(numbers)).toHaveLength(2);
  });

  it("treats numbers with no cached rating as healthy", () => {
    const numbers = [makeNumber("A"), makeNumber("B", { qualityRating: "RED" })];
    const result = filterHealthyNumbers(numbers);
    expect(result.map((n) => n.phoneNumberId)).toEqual(["A"]);
  });
});

describe("distributeContactsWeighted", () => {
  it("falls back to an even split when no number has a cached tier", () => {
    const numbers = [makeNumber("A"), makeNumber("B")];
    const result = distributeContactsWeighted(makeContacts(10), numbers);
    expect(result["A"]).toHaveLength(5);
    expect(result["B"]).toHaveLength(5);
  });

  it("weights distribution by messaging tier when cached", () => {
    // A is TIER_10K (10000), B is TIER_250 (250) — A should get the vast majority.
    const numbers = [
      makeNumber("A", { messagingLimit: "TIER_10K" }),
      makeNumber("B", { messagingLimit: "TIER_250" }),
    ];
    const result = distributeContactsWeighted(makeContacts(1000), numbers);
    expect(result["A"].length).toBeGreaterThan(result["B"].length);
    expect(result["A"].length + result["B"].length).toBe(1000);
  });

  it("always assigns exactly all contacts, with no loss from rounding", () => {
    const numbers = [
      makeNumber("A", { messagingLimit: "TIER_250" }),
      makeNumber("B", { messagingLimit: "TIER_1K" }),
      makeNumber("C", { messagingLimit: "TIER_50" }),
    ];
    const contacts = makeContacts(37); // an odd count to stress the remainder logic
    const result = distributeContactsWeighted(contacts, numbers);
    const total = Object.values(result).reduce((sum, c) => sum + c.length, 0);
    expect(total).toBe(37);
  });

  it("gives a number with no cached tier the average weight, not zero", () => {
    const numbers = [
      makeNumber("A", { messagingLimit: "TIER_1K" }),
      makeNumber("B"), // no cached tier
    ];
    const result = distributeContactsWeighted(makeContacts(100), numbers);
    expect(result["B"].length).toBeGreaterThan(0);
  });

  it("throws when no numbers are given", () => {
    expect(() => distributeContactsWeighted(makeContacts(1), [])).toThrow();
  });
});
