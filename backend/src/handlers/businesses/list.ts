import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    // Paginate through the full Scan — without this, results silently truncate
    // once the table exceeds DynamoDB's ~1MB Scan page.
    const items: Record<string, any>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(
        new ScanCommand({ TableName: TABLES.BUSINESSES, ExclusiveStartKey: lastKey })
      );
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    const businesses = items.map((item) => ({
      businessId: item.businessId,
      businessName: item.businessName,
      metaBusinessId: item.metaBusinessId || "",
      provider: item.provider || "meta",
      hasAccessToken: Boolean(item.accessToken),
      // apiKey/endpoint are secrets (equivalent to Meta's accessToken) — never exposed to the frontend.
      // hasApiKey/hasEndpoint let the edit UI show "configured" without revealing the value.
      phoneNumbers: (item.phoneNumbers || []).map((pn: Record<string, string>) => ({
        phoneNumberId: pn.phoneNumberId,
        displayNumber: pn.displayNumber,
        displayName: pn.displayName,
        wabaid: pn.wabaid,
        hasApiKey: Boolean(pn.apiKey),
        endpoint: pn.endpoint,
        // Not secrets — cached quality/tier metadata, needed client-side for the
        // campaign wizard's capacity/delivery-time estimate (see lib/capacity.ts).
        qualityRating: pn.qualityRating,
        messagingLimit: pn.messagingLimit,
      })),
      createdAt: item.createdAt,
    }));

    return success({ businesses }, origin);
  } catch (err) {
    console.error("Error listing businesses:", err);
    return error(500, "Failed to list businesses", origin);
  }
};
