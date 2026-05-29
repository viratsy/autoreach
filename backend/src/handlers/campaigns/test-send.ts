import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

/**
 * Send a test message from all selected numbers to a test phone number.
 * POST /campaigns/test-send
 * { businessId, selectedNumbers, templateName, templateMappings, parameterValues, testPhone }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const {
      businessId,
      selectedNumbers,
      templateName,
      templateMappings,
      parameterValues,
      testPhone,
    } = JSON.parse(event.body || "{}");

    if (!businessId || !testPhone || !selectedNumbers?.length) {
      return error(400, "businessId, testPhone, and selectedNumbers are required", origin);
    }

    // Get business for access token
    const bizResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.BUSINESSES,
        Key: { PK: `BIZ#${businessId}`, SK: "METADATA" },
      })
    );

    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);

    const accessToken = business.accessToken;
    const results: { phoneNumberId: string; displayName: string; status: string; error?: string; messageId?: string }[] = [];

    // Send test from each selected number
    for (const number of selectedNumbers) {
      const tplName = templateMappings?.[number.phoneNumberId] || templateName;

      try {
        const response = await fetch(
          `https://graph.facebook.com/v18.0/${number.phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: testPhone,
              type: "template",
              template: {
                name: tplName,
                language: { code: "en" },
                components: buildTemplateComponents(parameterValues),
              },
            }),
          }
        );

        const data = (await response.json()) as { messages?: { id: string; message_status?: string }[]; error?: { message: string; code?: number } };

        if (response.ok && data.messages?.[0]) {
          results.push({
            phoneNumberId: number.phoneNumberId,
            displayName: number.displayName,
            status: "sent",
            messageId: data.messages[0].id,
          });
        } else {
          results.push({
            phoneNumberId: number.phoneNumberId,
            displayName: number.displayName,
            status: "failed",
            error: data.error?.message || `HTTP ${response.status}`,
          });
        }
      } catch (err) {
        results.push({
          phoneNumberId: number.phoneNumberId,
          displayName: number.displayName,
          status: "failed",
          error: err instanceof Error ? err.message : "Request failed",
        });
      }
    }

    return success({ results }, origin);
  } catch (err) {
    console.error("Test send error:", err);
    return error(500, "Test send failed", origin);
  }
};

/**
 * Build template components array for Meta API.
 * Non-URL values go as body parameters.
 * URL values go as button parameters (CTA buttons).
 */
function buildTemplateComponents(parameterValues: Record<string, string>) {
  const sortedEntries = Object.entries(parameterValues)
    .sort(([a], [b]) => Number(a) - Number(b));

  const components: unknown[] = [];

  // Separate body params (non-URL) and button params (URLs)
  const bodyValues = sortedEntries
    .filter(([, v]) => !v.startsWith("http://") && !v.startsWith("https://"))
    .map(([, value]) => ({ type: "text", text: value }));

  const urlValues = sortedEntries
    .filter(([, v]) => v.startsWith("http://") || v.startsWith("https://"))
    .map(([, value]) => value);

  // Add body parameters
  if (bodyValues.length > 0) {
    components.push({
      type: "body",
      parameters: bodyValues,
    });
  }

  // Add button parameters for URL buttons
  urlValues.forEach((url, index) => {
    components.push({
      type: "button",
      sub_type: "url",
      index: index,
      parameters: [{ type: "text", text: url }],
    });
  });

  return components;
}
