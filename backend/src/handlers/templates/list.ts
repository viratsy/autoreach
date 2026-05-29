import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

/**
 * List templates for a business, optionally filtered by phone number IDs.
 * GET /templates?businessId=xxx&phoneNumberIds=id1,id2
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const businessId = event.queryStringParameters?.businessId;
    const phoneNumberIds = event.queryStringParameters?.phoneNumberIds?.split(",") || [];

    if (!businessId) return error(400, "businessId is required", origin);

    // Query all templates for this business
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLES.TEMPLATES,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `BIZ#${businessId}`,
          ":prefix": "TPL#",
        },
      })
    );

    const items = result.Items || [];

    const templateMap: Record<string, {
      templateName: string;
      category: string;
      parameterCount: number;
      components: unknown[];
      availableOn: string[];
      categoryPerNumber: Record<string, string>;
      paramCountPerNumber: Record<string, number>;
    }> = {};

    for (const item of items) {
      // SK format: TPL#<phoneNumberId>#<templateName>
      const skParts = item.SK.split("#");
      const phoneNumberId = skParts[1];
      const templateName = item.templateName;

      // Filter by selected numbers if provided
      if (phoneNumberIds.length > 0 && !phoneNumberIds.includes(phoneNumberId)) {
        continue;
      }

      if (!templateMap[templateName]) {
        templateMap[templateName] = {
          templateName,
          category: item.category,
          parameterCount: item.parameterCount,
          components: item.components,
          availableOn: [],
          categoryPerNumber: {},
          paramCountPerNumber: {},
        };
      }
      templateMap[templateName].availableOn.push(phoneNumberId);
      templateMap[templateName].categoryPerNumber[phoneNumberId] = item.category;
      templateMap[templateName].paramCountPerNumber[phoneNumberId] = item.parameterCount;

      // If any number has MARKETING, mark overall as MARKETING
      if (item.category === "MARKETING") {
        templateMap[templateName].category = "MARKETING";
      }
    }

    const templates = Object.values(templateMap);

    return success({ templates }, origin);
  } catch (err) {
    console.error("List templates error:", err);
    return error(500, "Failed to list templates", origin);
  }
};
