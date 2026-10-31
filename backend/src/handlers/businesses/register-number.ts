import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

/**
 * Registers a phone number on the WhatsApp Cloud API — required once per
 * number before it can send/receive messages. Uses the owning business's
 * stored accessToken (same source subscribe-webhooks.ts uses), so this only
 * works correctly when that token belongs to the right Meta app for this
 * number's WABA — see the skill_nation token fix (business token now points
 * at AutoReach-SN-HR/AutoReach-SN-NP, not an unrelated app).
 *
 * POST /businesses/register-number { businessId, phoneNumberId, pin }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const { businessId, phoneNumberId, pin } = JSON.parse(event.body || "{}");
    if (!businessId || !phoneNumberId || !pin) {
      return error(400, "businessId, phoneNumberId and pin are required", origin);
    }

    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);

    const accessToken = business.accessToken;
    if (!accessToken) return error(400, "Business has no access token configured", origin);

    const res = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    });
    const data = (await res.json()) as { success?: boolean; error?: { message: string } };

    if (res.ok && data.success) {
      return success({ phoneNumberId, status: "registered" }, origin);
    }
    return error(400, data.error?.message || `Registration failed (HTTP ${res.status})`, origin);
  } catch (err) {
    console.error("Register number error:", err);
    return error(500, "Failed to register number", origin);
  }
};
