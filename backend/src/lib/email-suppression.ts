import { createHmac, timingSafeEqual } from "crypto";
import { GetCommand, PutCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

const TABLE = process.env.EMAIL_SUPPRESSION_TABLE || `autoreach-email-suppression-${process.env.ENV_NAME || "hardik"}`;
const SECRET = process.env.JWT_SECRET || "";

export type SuppressionReason = "unsubscribe" | "bounce" | "complaint" | "manual";

/**
 * Addresses that must never be emailed again.
 *
 * Separate from the WhatsApp stop list because it is keyed by email, not phone,
 * and because it is fed by things WhatsApp has no equivalent of — AWS telling
 * us an address hard-bounced or someone hit "report spam". Both of those wreck
 * a sending reputation if ignored, and a suspended SES identity takes the whole
 * account's mail down, OTP logins included.
 */
export const normalizeEmail = (email: string) => (email || "").trim().toLowerCase();

/**
 * Unsubscribe links are signed rather than stored: a random token would need a
 * row written per recipient per campaign (millions of writes for no benefit).
 * The signature is what stops someone enumerating the endpoint to unsubscribe
 * other people's addresses.
 */
export function signUnsubscribe(email: string): string {
  const normalized = normalizeEmail(email);
  const payload = Buffer.from(normalized).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(normalized).digest("base64url").slice(0, 16);
  return `${payload}.${sig}`;
}

export function verifyUnsubscribe(token: string): string | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  let email: string;
  try {
    email = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", SECRET).update(email).digest("base64url").slice(0, 16);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return email;
}

export async function suppress(email: string, reason: SuppressionReason, detail?: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  await docClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: { email: normalized, reason, detail: detail || "", suppressedAt: new Date().toISOString() },
    })
  );
}

export async function isSuppressed(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return true;
  const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: { email: normalized } }));
  return !!res.Item;
}

/**
 * Batch form for the send path — one BatchGetItem per 100 addresses instead of
 * a read per recipient, which at these volumes is the difference between a
 * rounding error and a real DynamoDB bill.
 */
export async function filterSuppressed(emails: string[]): Promise<Set<string>> {
  const suppressed = new Set<string>();
  const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];

  for (let i = 0; i < unique.length; i += 100) {
    let keys = unique.slice(i, i + 100).map((email) => ({ email }));
    let attempts = 0;
    while (keys.length && attempts < 5) {
      const res = await docClient.send(
        new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } })
      );
      for (const item of (res.Responses?.[TABLE] || []) as { email: string }[]) {
        suppressed.add(item.email);
      }
      keys = (res.UnprocessedKeys?.[TABLE]?.Keys || []) as typeof keys;
      attempts++;
    }
  }
  return suppressed;
}

/** The unsubscribe footer appended to every email, plus the List-Unsubscribe header value. */
export function unsubscribeFooter(email: string, baseUrl: string): { html: string; text: string; url: string } {
  const url = `${baseUrl}/u/${signUnsubscribe(email)}`;
  return {
    url,
    text: `\n\n---\nDon't want these emails? Unsubscribe: ${url}`,
    html:
      '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e0e0e0;font-size:12px;color:#5f6368">' +
      `Don't want these emails? <a href="${url}" style="color:#5f6368">Unsubscribe</a>.` +
      "</div>",
  };
}
