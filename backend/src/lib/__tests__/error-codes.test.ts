import { META_ERROR_CODES, extractKnownErrorCode } from "../error-codes";

describe("extractKnownErrorCode", () => {
  it("matches a bare numeric code (the webhook status-update storage format)", () => {
    expect(extractKnownErrorCode("131042")).toBe("131042");
  });

  it("matches a known code embedded in Meta's error message text", () => {
    expect(extractKnownErrorCode("(#131042) Payment method issue")).toBe("131042");
  });

  it("returns null for an unrecognized numeric code", () => {
    expect(extractKnownErrorCode("999999")).toBeNull();
  });

  it("returns null for free text with no embedded code", () => {
    expect(extractKnownErrorCode("Unknown")).toBeNull();
  });

  it("does not false-positive on short numbers that aren't real error codes", () => {
    // e.g. a phone number fragment or count accidentally landing in errorCode
    expect(extractKnownErrorCode("42")).toBeNull();
  });
});

describe("META_ERROR_CODES retryability matches documented WhatsApp semantics", () => {
  it("treats a payment/billing issue as retryable (operator likely just fixed billing)", () => {
    expect(META_ERROR_CODES["131042"].retryable).toBe(true);
  });

  it("treats an invalid/non-WhatsApp recipient as not retryable", () => {
    expect(META_ERROR_CODES["131026"].retryable).toBe(false);
  });

  it("treats a policy-violation block as not retryable", () => {
    expect(META_ERROR_CODES["368"].retryable).toBe(false);
  });
});
