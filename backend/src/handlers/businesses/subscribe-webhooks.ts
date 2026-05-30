import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

/**
 * Subscribe all WABAs in a business to the app for webhook delivery.
 * POST /businesses/subscribe-webhooks { businessId }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { businessId } = JSON.parse(event.body || "{}");
    if (!businessId) return error(400, "businessId is required", origin);

    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);

    const accessToken = business.accessToken;
    const phoneNumbers = business.phoneNumbers || [];

    // Get unique WABAs
    const wabaIds: string[] = [...new Set(phoneNumbers.map((pn: { wabaid: string }) => pn.wabaid).filter(Boolean))] as string[];

    const results: { wabaid: string; status: string; error?: string }[] = [];

    for (const wabaid of wabaIds) {
      try {
        const res = await fetch(
          `https://graph.facebook.com/v18.0/${wabaid}/subscribed_apps`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );

        const data = (await res.json()) as { success?: boolean; error?: { message: string } };

        if (res.ok && data.success) {
          results.push({ wabaid, status: "subscribed" });
        } else {
          results.push({ wabaid, status: "failed", error: data.error?.message || `HTTP ${res.status}` });
        }
      } catch (err) {
        results.push({ wabaid, status: "failed", error: err instanceof Error ? err.message : "Request failed" });
      }
    }

    return success({ results }, origin);
  } catch (err) {
    console.error("Subscribe webhooks error:", err);
    return error(500, "Failed to subscribe webhooks", origin);
  }
};
