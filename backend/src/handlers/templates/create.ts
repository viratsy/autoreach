import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { PhoneNumber } from "../../lib/types";

/**
 * Create a brand-new WhatsApp template on Meta and submit it for approval on
 * the given numbers' WABAs.
 * POST /templates/create
 * { businessId, templateName, category, language, bodyText, headerText?, headerImageUrl?, footerText?, targetPhoneNumberIds }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const {
      businessId,
      templateName,
      category,
      language,
      bodyText,
      headerText,
      headerImageUrl,
      footerText,
      targetPhoneNumberIds,
    } = JSON.parse(event.body || "{}") as {
      businessId?: string;
      templateName?: string;
      category?: string;
      language?: string;
      bodyText?: string;
      headerText?: string;
      headerImageUrl?: string;
      footerText?: string;
      targetPhoneNumberIds?: string[];
    };

    if (!businessId || !templateName || !category || !bodyText || !targetPhoneNumberIds?.length) {
      return error(400, "businessId, templateName, category, bodyText, and targetPhoneNumberIds are required", origin);
    }
    if (!/^[a-z0-9_]+$/.test(templateName)) {
      return error(400, "Template name may only contain lowercase letters, numbers, and underscores", origin);
    }

    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);
    if ((business.provider || "meta") !== "meta") {
      return error(400, "Template creation via Meta API is only available for Meta businesses", origin);
    }
    const accessToken = business.accessToken;
    const phoneNumbers = (business.phoneNumbers || []) as PhoneNumber[];

    const paramCount = (bodyText.match(/\{\{\d+\}\}/g) || []).length;
    const bodyComponent: Record<string, unknown> = { type: "BODY", text: bodyText };
    if (paramCount > 0) {
      bodyComponent.example = {
        body_text: [Array.from({ length: paramCount }, (_, i) => `Example${i + 1}`)],
      };
    }

    const components: Record<string, unknown>[] = [];

    if (headerImageUrl) {
      const handle = await uploadImageToMeta(headerImageUrl, accessToken);
      const headerComp: Record<string, unknown> = { type: "HEADER", format: "IMAGE" };
      if (handle) headerComp.example = { header_handle: [handle] };
      components.push(headerComp);
    } else if (headerText) {
      components.push({ type: "HEADER", format: "TEXT", text: headerText });
    }

    components.push(bodyComponent);

    if (footerText) {
      components.push({ type: "FOOTER", text: footerText });
    }

    const results: { phoneNumberId: string; displayName: string; status: string; error?: string }[] = [];

    for (const phoneNumberId of targetPhoneNumberIds) {
      const number = phoneNumbers.find((pn) => pn.phoneNumberId === phoneNumberId);
      const wabaid = number?.wabaid;
      if (!wabaid) {
        results.push({ phoneNumberId, displayName: number?.displayName || phoneNumberId, status: "failed", error: "No WABA ID configured" });
        continue;
      }

      try {
        const createRes = await fetch(
          `https://graph.facebook.com/v25.0/${wabaid}/message_templates`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: templateName, category, language: language || "en_US", components }),
          }
        );
        const createData = (await createRes.json()) as { id?: string; error?: { message: string } };

        if (createRes.ok && createData.id) {
          results.push({ phoneNumberId, displayName: number.displayName, status: "submitted" });
          // Reflect immediately in our local Templates table (status will be corrected by the next sync)
          await docClient.send(
            new PutCommand({
              TableName: TABLES.TEMPLATES,
              Item: {
                PK: `BIZ#${businessId}`,
                SK: `TPL#${phoneNumberId}#${templateName}`,
                templateName,
                language: language || "en_US",
                category,
                components,
                parameterCount: paramCount,
                status: "pending",
                lastSyncedAt: new Date().toISOString(),
              },
            })
          );
        } else {
          results.push({
            phoneNumberId,
            displayName: number.displayName,
            status: "failed",
            error: createData.error?.message || `HTTP ${createRes.status}`,
          });
        }
      } catch (err) {
        results.push({
          phoneNumberId,
          displayName: number?.displayName || phoneNumberId,
          status: "failed",
          error: err instanceof Error ? err.message : "Request failed",
        });
      }
    }

    return success({ results }, origin);
  } catch (err) {
    console.error("Template create error:", err);
    return error(500, "Failed to create template", origin);
  }
};

/**
 * Upload image to Meta via Resumable Upload API and return the file handle.
 */
async function uploadImageToMeta(imageUrl: string, accessToken: string): Promise<string | null> {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const fileSize = imageBuffer.length;

    const appId = process.env.META_APP_ID || "";
    if (!appId) return null;

    const sessionRes = await fetch(
      `https://graph.facebook.com/v25.0/${appId}/uploads?file_length=${fileSize}&file_type=${encodeURIComponent(contentType)}`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const sessionData = (await sessionRes.json()) as { id?: string };
    if (!sessionData.id) return null;

    const uploadRes = await fetch(`https://graph.facebook.com/v25.0/${sessionData.id}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${accessToken}`, "Content-Type": contentType, file_offset: "0" },
      body: imageBuffer,
    });
    const uploadData = (await uploadRes.json()) as { h?: string };
    return uploadData.h || null;
  } catch (err) {
    console.error("uploadImageToMeta error:", err);
    return null;
  }
}
