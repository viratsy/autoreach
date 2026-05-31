import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLES.BUSINESSES })
    );

    const businesses = (result.Items || []).map((item) => ({
      businessId: item.businessId,
      businessName: item.businessName,
      metaBusinessId: item.metaBusinessId || "",
      accessToken: item.accessToken, // needed for quality check
      phoneNumbers: (item.phoneNumbers || []).map((pn: Record<string, string>) => ({
        phoneNumberId: pn.phoneNumberId,
        displayNumber: pn.displayNumber,
        displayName: pn.displayName,
        wabaid: pn.wabaid,
      })),
      createdAt: item.createdAt,
    }));

    // Fetch quality ratings for each number
    for (const biz of businesses) {
      if (!biz.accessToken) continue;
      for (const pn of biz.phoneNumbers) {
        try {
          const res = await fetch(
            `https://graph.facebook.com/v25.0/${pn.phoneNumberId}?fields=quality_rating,messaging_limit_tier,status`,
            { headers: { Authorization: `Bearer ${biz.accessToken}` } }
          );
          const data = (await res.json()) as { quality_rating?: string; messaging_limit_tier?: string; status?: string };
          (pn as Record<string, unknown>).qualityRating = data.quality_rating || "UNKNOWN";
          (pn as Record<string, unknown>).messagingLimit = data.messaging_limit_tier || "";
          (pn as Record<string, unknown>).status = data.status || "";
        } catch {
          (pn as Record<string, unknown>).qualityRating = "UNKNOWN";
        }
      }
      // Remove token from response
      delete (biz as Record<string, unknown>).accessToken;
    }

    return success({ businesses }, origin);
  } catch (err) {
    console.error("Error listing businesses:", err);
    return error(500, "Failed to list businesses", origin);
  }
};
