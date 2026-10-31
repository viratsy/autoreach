import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

/**
 * List templates for a business, optionally filtered by phone number IDs.
 * GET /templates?businessId=xxx&phoneNumberIds=id1,id2
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const businessId = event.queryStringParameters?.businessId;
    const phoneNumberIds = event.queryStringParameters?.phoneNumberIds?.split(",") || [];

    if (!businessId) return error(400, "businessId is required", origin);

    // Query all templates for this business. A business with many phone
    // numbers can have 1000+ template rows (one per number per template,
    // each carrying the full components blob) — comfortably past
    // DynamoDB's 1MB-per-Query response cap. An unpaginated single Query
    // silently truncates in SK order, which was making every template for
    // whichever phone numbers sorted past that cutoff appear "not synced"
    // even though their rows existed — no error anywhere, since truncation
    // isn't a failure. Must paginate through every page.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: Record<string, any>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLES.TEMPLATES,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `BIZ#${businessId}`,
            ":prefix": "TPL#",
          },
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    const templateMap: Record<string, {
      templateName: string;
      category: string;
      parameterCount: number;
      components: unknown[];
      availableOn: string[];
      categoryPerNumber: Record<string, string>;
      paramCountPerNumber: Record<string, number>;
      hasImageHeaderPerNumber: Record<string, boolean>;
      statusPerNumber: Record<string, string>;
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

      // Check if template has image header
      const hasImageHeader = (item.components || []).some(
        (c: { type?: string; format?: string }) =>
          (c.type === "HEADER" || c.type === "header") &&
          (c.format === "IMAGE" || c.format === "image")
      );

      if (!templateMap[templateName]) {
        templateMap[templateName] = {
          templateName,
          category: item.category,
          parameterCount: item.parameterCount,
          // Whichever number is scanned first sets this, and the same template
          // name can be approved with a different STRUCTURE on each number --
          // 20min_hr_bi has an IMAGE header on 4 of H R Academy's numbers and
          // no header at all on the other 13. First-wins meant the workshop
          // config's "does this need a header image?" check could land on a
          // headerless copy and never ask for one. Preferring the variant that
          // HAS an image header (below) makes the aggregate describe what the
          // template is capable of; hasImageHeaderPerNumber remains the source
          // of truth for which numbers actually take one.
          components: item.components,
          availableOn: [],
          categoryPerNumber: {},
          paramCountPerNumber: {},
          hasImageHeaderPerNumber: {},
          statusPerNumber: {},
        };
      }
      // See the note above: keep the richest variant so previews and header
      // checks reflect the template's full shape rather than a coin flip.
      if (hasImageHeader) {
        const current = templateMap[templateName].components as { type?: string; format?: string }[];
        const currentHasImage = (current || []).some(
          (c) => String(c.type || "").toUpperCase() === "HEADER" && String(c.format || "").toUpperCase() === "IMAGE"
        );
        if (!currentHasImage) templateMap[templateName].components = item.components;
      }

      templateMap[templateName].availableOn.push(phoneNumberId);
      templateMap[templateName].categoryPerNumber[phoneNumberId] = item.category;
      templateMap[templateName].paramCountPerNumber[phoneNumberId] = item.parameterCount;
      templateMap[templateName].hasImageHeaderPerNumber[phoneNumberId] = hasImageHeader;
      templateMap[templateName].statusPerNumber[phoneNumberId] = item.status || "approved";

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
