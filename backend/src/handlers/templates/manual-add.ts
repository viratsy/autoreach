import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

/**
 * Manually register a template for a provider with no template-list API (AiSensy).
 * POST /templates/manual { businessId, phoneNumberId, templateName, parameterCount }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const { businessId, phoneNumberId, templateName, parameterCount } = JSON.parse(event.body || "{}") as {
      businessId?: string;
      phoneNumberId?: string;
      templateName?: string;
      parameterCount?: number;
    };

    if (!businessId || !phoneNumberId || !templateName) {
      return error(400, "businessId, phoneNumberId and templateName are required", origin);
    }

    await docClient.send(
      new PutCommand({
        TableName: TABLES.TEMPLATES,
        Item: {
          PK: `BIZ#${businessId}`,
          SK: `TPL#${phoneNumberId}#${templateName}`,
          templateName,
          language: "en",
          category: "unknown",
          components: [],
          parameterCount: parameterCount ?? 0,
          status: "approved",
          source: "aisensy",
          manuallyAdded: true,
          lastSyncedAt: new Date().toISOString(),
        },
      })
    );

    return success({ templateName }, origin);
  } catch (err) {
    console.error("Manual template add error:", err);
    return error(500, "Failed to add template", origin);
  }
};
