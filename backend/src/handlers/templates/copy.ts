import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

/**
 * Copy a template from one number to other WABAs.
 * POST /templates/copy
 * { businessId, sourcePhoneNumberId, templateName, targetWabaIds }
 * 
 * Reads the template structure from the source, then submits it
 * to each target WABA via Meta API.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { businessId, sourcePhoneNumberId, templateName, targetWabaIds } = JSON.parse(event.body || "{}");

    if (!businessId || !sourcePhoneNumberId || !templateName || !targetWabaIds?.length) {
      return error(400, "businessId, sourcePhoneNumberId, templateName, and targetWabaIds are required", origin);
    }

    // Get business for access token
    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);
    const accessToken = business.accessToken;

    // Get source template from our DB
    const tplResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.TEMPLATES,
        Key: { PK: `BIZ#${businessId}`, SK: `TPL#${sourcePhoneNumberId}#${templateName}` },
      })
    );
    const sourceTemplate = tplResult.Item;
    if (!sourceTemplate) return error(404, "Source template not found", origin);

    // Get the full template structure from Meta API (our DB might not have all fields)
    const sourceNumber = business.phoneNumbers?.find(
      (pn: { phoneNumberId: string }) => pn.phoneNumberId === sourcePhoneNumberId
    );
    const sourceWabaid = sourceNumber?.wabaid;

    let templateStructure: { name: string; category: string; language: string; components: unknown[] } | null = null;

    if (sourceWabaid) {
      const res = await fetch(
        `https://graph.facebook.com/v25.0/${sourceWabaid}/message_templates?name=${templateName}&limit=1`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = (await res.json()) as { data?: { name: string; category: string; language: string; components: unknown[] }[] };
      templateStructure = data.data?.[0] || null;
    }

    if (!templateStructure) {
      return error(404, "Could not fetch template structure from Meta", origin);
    }

    // Submit template to each target WABA
    const results: { wabaid: string; status: string; error?: string }[] = [];

    for (const targetWabaid of targetWabaIds) {
      // Skip if same as source
      if (targetWabaid === sourceWabaid) {
        results.push({ wabaid: targetWabaid, status: "skipped", error: "Same as source" });
        continue;
      }

      try {
        // Submit components as-is (including examples for approval)
        const createRes = await fetch(
          `https://graph.facebook.com/v25.0/${targetWabaid}/message_templates`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: templateStructure.name,
              category: templateStructure.category,
              language: templateStructure.language,
              components: templateStructure.components,
            }),
          }
        );

        const createData = (await createRes.json()) as { id?: string; error?: { message: string; code: number } };

        if (createRes.ok && createData.id) {
          results.push({ wabaid: targetWabaid, status: "submitted" });
        } else {
          results.push({
            wabaid: targetWabaid,
            status: "failed",
            error: createData.error?.message || `HTTP ${createRes.status}`,
          });
        }
      } catch (err) {
        results.push({
          wabaid: targetWabaid,
          status: "failed",
          error: err instanceof Error ? err.message : "Request failed",
        });
      }
    }

    return success({ results }, origin);
  } catch (err) {
    console.error("Template copy error:", err);
    return error(500, "Failed to copy template", origin);
  }
};
