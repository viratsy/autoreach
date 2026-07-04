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
    const { businessId, sourcePhoneNumberId, templateName, targetWabaIds, headerImageUrl } = JSON.parse(event.body || "{}");

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
        // Deep clone components so we can modify per-target
        const components = JSON.parse(JSON.stringify(templateStructure.components)) as any[];

        // Handle image/video/document headers — upload to Meta to get a file handle
        for (const comp of components) {
          if (comp.type === "HEADER" && ["IMAGE", "VIDEO", "DOCUMENT"].includes(comp.format)) {
            if (headerImageUrl) {
              const handle = await uploadImageToMeta(headerImageUrl, accessToken);
              if (handle) {
                comp.example = { header_handle: [handle] };
              } else {
                delete comp.example;
              }
            } else {
              delete comp.example;
            }
          }
        }

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
              components,
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

/**
 * Upload image to Meta via Resumable Upload API and return the file handle.
 * Steps: 1) Download image 2) Create upload session 3) Upload bytes 4) Get handle
 */
async function uploadImageToMeta(imageUrl: string, accessToken: string): Promise<string | null> {
  try {
    // 1. Download the image
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      console.error(`Failed to download image: ${imgRes.status}`);
      return null;
    }
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const fileSize = imageBuffer.length;

    // 2. Create upload session using the app ID
    // Meta's upload API: POST /{app-id}/uploads?file_length=X&file_type=Y
    const appId = process.env.META_APP_ID || "";
    if (!appId) {
      console.error("META_APP_ID not set");
      return null;
    }

    const sessionRes = await fetch(
      `https://graph.facebook.com/v25.0/${appId}/uploads?file_length=${fileSize}&file_type=${encodeURIComponent(contentType)}`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const sessionData = (await sessionRes.json()) as { id?: string; error?: { message: string } };
    if (!sessionData.id) {
      console.error("Upload session failed:", sessionData.error?.message);
      return null;
    }

    // 3. Upload the file bytes
    const uploadRes = await fetch(
      `https://graph.facebook.com/v25.0/${sessionData.id}`,
      {
        method: "POST",
        headers: {
          Authorization: `OAuth ${accessToken}`,
          "Content-Type": contentType,
          file_offset: "0",
        },
        body: imageBuffer,
      }
    );
    const uploadData = (await uploadRes.json()) as { h?: string; error?: { message: string } };
    if (!uploadData.h) {
      console.error("Upload failed:", uploadData.error?.message);
      return null;
    }

    return uploadData.h;
  } catch (err) {
    console.error("uploadImageToMeta error:", err);
    return null;
  }
}
