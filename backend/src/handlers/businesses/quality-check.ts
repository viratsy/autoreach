import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

/**
 * Check quality rating for phone numbers.
 * POST /businesses/quality-check { businessId, phoneNumberIds }
 * If phoneNumberIds is empty/null, checks all numbers in the business.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { businessId, phoneNumberIds } = JSON.parse(event.body || "{}");
    if (!businessId) return error(400, "businessId is required", origin);

    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);

    const accessToken = business.accessToken;
    const allNumbers = business.phoneNumbers || [];

    // Filter to requested numbers or check all
    const numbersToCheck = phoneNumberIds?.length
      ? allNumbers.filter((pn: { phoneNumberId: string }) => phoneNumberIds.includes(pn.phoneNumberId))
      : allNumbers;

    const results: Record<string, { qualityRating: string; messagingLimit: string; status: string }> = {};

    for (const pn of numbersToCheck) {
      try {
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${pn.phoneNumberId}?fields=quality_rating,messaging_limit_tier,status`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const data = (await res.json()) as { quality_rating?: string; messaging_limit_tier?: string; status?: string };
        results[pn.phoneNumberId] = {
          qualityRating: data.quality_rating || "UNKNOWN",
          messagingLimit: data.messaging_limit_tier || "",
          status: data.status || "",
        };
      } catch {
        results[pn.phoneNumberId] = { qualityRating: "UNKNOWN", messagingLimit: "", status: "" };
      }
    }

    return success({ results }, origin);
  } catch (err) {
    console.error("Quality check error:", err);
    return error(500, "Failed to check quality", origin);
  }
};
