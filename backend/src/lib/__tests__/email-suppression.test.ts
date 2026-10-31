process.env.JWT_SECRET = "test-secret-for-unsubscribe-tokens";

import { signUnsubscribe, verifyUnsubscribe, normalizeEmail, unsubscribeFooter } from "../email-suppression";

describe("unsubscribe tokens", () => {
  it("round-trips an address", () => {
    const token = signUnsubscribe("Arun.Shukla@Gmail.com");
    expect(verifyUnsubscribe(token)).toBe("arun.shukla@gmail.com");
  });

  // The signature is the only thing stopping someone iterating the endpoint to
  // unsubscribe other people's addresses — tokens are stateless by design, so
  // there's no stored row to check against.
  it("rejects a token whose address was swapped", () => {
    const token = signUnsubscribe("real@example.com");
    const [, sig] = token.split(".");
    const forged = `${Buffer.from("victim@example.com").toString("base64url")}.${sig}`;
    expect(verifyUnsubscribe(forged)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const [payload] = signUnsubscribe("real@example.com").split(".");
    expect(verifyUnsubscribe(`${payload}.aaaaaaaaaaaaaaaa`)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyUnsubscribe("")).toBeNull();
    expect(verifyUnsubscribe("no-dot")).toBeNull();
    expect(verifyUnsubscribe("!!!.!!!")).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims so the same address suppresses once", () => {
    expect(normalizeEmail("  Arun@Example.COM ")).toBe("arun@example.com");
  });
});

describe("unsubscribeFooter", () => {
  it("builds a one-click URL on the short-link domain", () => {
    const f = unsubscribeFooter("a@b.com", "https://l.hardikraja.com");
    expect(f.url.startsWith("https://l.hardikraja.com/u/")).toBe(true);
    expect(verifyUnsubscribe(f.url.split("/u/")[1])).toBe("a@b.com");
    expect(f.html).toContain("Unsubscribe");
    expect(f.text).toContain(f.url);
  });
});
