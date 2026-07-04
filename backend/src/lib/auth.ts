import { APIGatewayProxyEvent } from "aws-lambda";
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
