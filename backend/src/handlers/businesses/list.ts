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
      })),
      createdAt: item.createdAt,
    }));

    return success({ businesses }, origin);
  } catch (err) {
    console.error("Error listing businesses:", err);
    return error(500, "Failed to list businesses", origin);
  }
};
