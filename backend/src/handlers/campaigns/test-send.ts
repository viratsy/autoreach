import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getProvider } from "../../lib/providers";
import { PhoneNumber } from "../../lib/types";
import { getAuthEmail } from "../../lib/auth";

/**
 * Send a test message from all selected numbers to a test phone number.
 * POST /campaigns/test-send
 * { businessId, selectedNumbers, templateName, templateMappings, parameterValues, testPhone }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

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
    const provider = (business.provider as string) || "meta";
    // Server-side source of truth for per-number secrets — never trust the client-supplied selectedNumbers for these.
    const bizNumbersById = new Map(
      ((business.phoneNumbers || []) as PhoneNumber[]).map((pn) => [pn.phoneNumberId, pn])
    );
    const results: { phoneNumberId: string; displayName: string; status: string; error?: string; messageId?: string }[] = [];

    // Send test from each selected number
    for (const number of selectedNumbers) {
      const tplName = templateMappings?.[number.phoneNumberId] || templateName;

      if (provider !== "meta") {
        const bizNumber = bizNumbersById.get(number.phoneNumberId);
        const providerImpl = getProvider(provider);
        const paramList = Object.entries(parameterValues as Record<string, string>)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, value]) => value);

        const result = providerImpl && bizNumber
          ? await providerImpl.sendMessage({
              phone: testPhone,
              contactName: "Test Contact",
              templateName: tplName,
              parameters: paramList,
              number: bizNumber,
            })
          : { ok: false, error: `Unknown provider "${provider}" or number not found` };

        results.push({
          phoneNumberId: number.phoneNumberId,
          displayName: number.displayName,
          status: result.ok ? "sent" : "failed",
          error: result.ok ? undefined : result.error,
          messageId: result.messageId,
        });
        continue;
      }

      try {
        // Meta's message API needs the template's name + language to match
        // EXACTLY (e.g. "en_US", not just "en") — look up the real approved
        // language instead of assuming, since it's not the same for every
        // template and a mismatch fails every number with error 132001
        // ("Template name does not exist in the translation").
        let templateLanguage = "en_US";
        const testWabaid = bizNumbersById.get(number.phoneNumberId)?.wabaid;
        if (testWabaid) {
          try {
            const tplRes = await fetch(
              `https://graph.facebook.com/v25.0/${testWabaid}/message_templates?name=${encodeURIComponent(tplName)}&limit=25`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const tplData = (await tplRes.json()) as { data?: { name: string; language?: string }[] };
            // ?name= matches by prefix on Meta's side — take the exact one,
            // or a same-prefixed sibling's language gets used and every send
            // fails with 132001.
            const tplMatch = (tplData.data || []).find((t) => t.name === tplName);
            if (tplMatch?.language) templateLanguage = tplMatch.language;
          } catch (err) {
            console.warn(`Language lookup failed for ${number.phoneNumberId}, defaulting to en_US:`, err);
          }
        }

        const requestBody = {
          messaging_product: "whatsapp",
          to: testPhone,
          type: "template",
          template: {
            name: tplName,
            language: { code: templateLanguage },
            components: buildTemplateComponents(
              parameterValues,
              // Only include image for numbers that need it
              numbersWithImageHeader?.includes(number.phoneNumberId) ? headerImageUrl : undefined
            ),
          },
        };

        console.log(`Sending to ${number.phoneNumberId}:`, JSON.stringify(requestBody));

        const response = await fetch(
          `https://graph.facebook.com/v25.0/${number.phoneNumberId}/messages`,
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
          const messageId = data.messages[0].id;
          results.push({
            phoneNumberId: number.phoneNumberId,
            displayName: number.displayName,
            status: "sent",
            messageId,
          });

          // Meta's response here only confirms the message was ACCEPTED, not
          // delivered — things like a payment/billing issue are often only
          // reported a few seconds later via the async status webhook. Write a
          // trackable record (matching webhook-worker.ts's GSI1PK lookup) so
          // test-send-status.ts can report a failure the wizard would otherwise
          // never learn about.
          try {
            await docClient.send(
              new PutCommand({
                TableName: TABLES.MESSAGES,
                Item: {
                  PK: `TESTSEND#${messageId}`,
                  SK: "METADATA",
                  GSI1PK: `METAMSG#${messageId}`,
                  GSI1SK: "TESTSEND",
                  phoneNumber: testPhone,
                  sendingNumberId: number.phoneNumberId,
                  metaMessageId: messageId,
                  status: "sent",
                  repliedAt: null,
                  errorCode: null,
                  sentAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              })
            );
          } catch (trackErr) {
            console.warn("Failed to write test-send tracking record (non-fatal):", trackErr);
          }
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
