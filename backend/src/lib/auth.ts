import { APIGatewayProxyEvent } from "aws-lambda";
import { timingSafeEqual } from "crypto";
import { verifyJWT } from "./jwt";

/**
 * Returns the logged-in user's email if the request carries a valid JWT, else null.
 * Handlers that mutate sensitive data (business config, API keys/tokens) must check this.
 */
export function getAuthEmail(event: APIGatewayProxyEvent): string | null {
  const header = event.headers?.Authorization || event.headers?.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const payload = verifyJWT(header.slice(7));
  return payload?.email || null;
}

/**
 * True when a request carries the shared service key, for machine callers that have no
 * inbox to receive an OTP in — the monthly WhatsApp spend pull from the accounting
 * stack, for one. Kept separate from the user JWT on purpose: that token is signed with
 * JWT_SECRET, which is the same value as the Meta webhook verify token, so handing it to
 * another system to self-sign with would put webhook verification in a second place too.
 *
 * Compared in constant time. A plain === on a secret leaks its prefix to anyone who can
 * measure the response, which for a public endpoint is everyone. Absent or empty
 * SERVICE_API_KEY means no service caller is allowed at all, never "allow everyone".
 */
export function isServiceCall(event: APIGatewayProxyEvent): boolean {
  const expected = process.env.SERVICE_API_KEY;
  if (!expected) return false;
  const supplied = event.headers?.["x-api-key"] || event.headers?.["X-Api-Key"];
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
