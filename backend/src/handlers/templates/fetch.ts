import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

/**
 * Fetch templates from Meta API for a given business.
 * Uses each phone number's wabaid to fetch templates.
 * POST /templates/fetch { businessId }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { businessId } = JSON.parse(event.body || "{}");
    if (!businessId) return error(400, "businessId is required", origin);

    // Get business record
    const bizResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.BUSINESSES,
        Key: { PK: `BIZ#${businessId}`, SK: "METADATA" },
      })
    );

    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);

    const accessToken = business.accessToken;
    const phoneNumbers = business.phoneNumbers || [];
    const allTemplates: Record<string, string[]> = {};

    // Fetch templates for each number using its wabaid
    for (const pn of phoneNumbers) {
      const wabaid = pn.wabaid;
      if (!wabaid) continue;

      const response = await fetch(
        `https://graph.facebook.com/v25.0/${wabaid}/message_templates?limit=100`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      const data = (await response.json()) as {
        data?: { name: string; language: string; category: string; status: string; components: unknown[] }[];
        error?: unknown;
      };

      if (!response.ok || !data.data) {
        console.error(`Failed to fetch templates for ${pn.phoneNumberId}:`, data.error);
        continue;
      }

      const templates = data.data.filter((t) => t.status === "APPROVED");

      // Store templates in DB
      for (const tpl of templates) {
        await docClient.send(
          new PutCommand({
            TableName: TABLES.TEMPLATES,
            Item: {
              PK: `BIZ#${businessId}`,
              SK: `TPL#${pn.phoneNumberId}#${tpl.name}`,
              templateName: tpl.name,
              language: tpl.language,
              category: tpl.category,
              components: tpl.components,
              parameterCount: countParameters(tpl.components),
              status: tpl.status.toLowerCase(),
              lastSyncedAt: new Date().toISOString(),
            },
          })
        );
      }

      allTemplates[pn.phoneNumberId] = templates.map((t) => t.name);
    }

    return success({ templates: allTemplates }, origin);
  } catch (err) {
    console.error("Template fetch error:", err);
    return error(500, "Failed to fetch templates", origin);
  }
};

function countParameters(components: unknown[]): number {
  let count = 0;
  for (const comp of components as { type: string; text?: string }[]) {
    if (comp.type === "BODY" && comp.text) {
      const matches = comp.text.match(/\{\{\d+\}\}/g);
      count += matches ? matches.length : 0;
    }
  }
  return count;
}
