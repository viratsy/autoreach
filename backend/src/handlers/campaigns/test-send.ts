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
      headerImageUrl,
      numbersWithImageHeader,
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
        const requestBody = {
          messaging_product: "whatsapp",
          to: testPhone,
          type: "template",
          template: {
            name: tplName,
            language: { code: "en" },
            components: buildTemplateComponents(
              parameterValues,
              // Only include image for numbers that need it
              numbersWithImageHeader?.includes(number.phoneNumberId) ? headerImageUrl : undefined
            ),
          },
        };

        console.log(`Sending to ${number.phoneNumberId}:`, JSON.stringify(requestBody));

        const response = await fetch(
          `https://graph.facebook.com/v18.0/${number.phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
          }
        );

        const data = (await response.json()) as { messages?: { id: string; message_status?: string }[]; error?: { message: string; code?: number } };

        console.log(`Response from ${number.phoneNumberId}:`, JSON.stringify(data));

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
 * Handles body parameters and optional header image.
 */
function buildTemplateComponents(parameterValues: Record<string, string>, headerImageUrl?: string) {
  const components: unknown[] = [];

  // Header image if provided
  if (headerImageUrl) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { link: headerImageUrl } }],
    });
  }

  // Body parameters
  const bodyParams = Object.entries(parameterValues)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, value]) => ({ type: "text", text: value }));

  if (bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParams,
    });
  }

  return components;
}
