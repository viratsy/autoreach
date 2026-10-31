import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

/**
 * Copy a template from one number to other WABAs — either other numbers on
 * the same business, or (with targetBusinessId) a different business in this
 * same account entirely, e.g. Skill Nation -> H R Academy. Reads the
 * template structure using the source's token, then submits it to each
 * target WABA using the TARGET business's own token when targetBusinessId is
 * given — the source's token essentially never has create-template
 * permission on a different business's WABA, since Meta scopes that per
 * Business Manager.
 * POST /templates/copy
 * { businessId, sourcePhoneNumberId, templateName, targetWabaIds, targetBusinessId? }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const { businessId, sourcePhoneNumberId, templateName, targetWabaIds, targetBusinessId, headerImageUrl } = JSON.parse(event.body || "{}");

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

    // Cross-business copy (e.g. Skill Nation -> H R Academy): the source's
    // own access token almost never has create-template permission on a
    // different business's WABA, since Meta's template API is per-Business-
    // Manager. Sidesteps that entirely — read the source template using the
    // SOURCE's token, then submit it using the TARGET business's OWN token,
    // exactly as if someone had logged into that business and created it by
    // hand. Only meaningful when both businesses live in this same account's
    // table, which is the only case this UI offers.
    let targetAccessToken = accessToken;
    if (targetBusinessId && targetBusinessId !== businessId) {
      const targetBizResult = await docClient.send(
        new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${targetBusinessId}`, SK: "METADATA" } })
      );
      const targetBusiness = targetBizResult.Item;
      if (!targetBusiness) return error(404, "Target business not found", origin);
      targetAccessToken = targetBusiness.accessToken;
    }

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
        `https://graph.facebook.com/v25.0/${sourceWabaid}/message_templates?name=${encodeURIComponent(templateName)}&limit=25`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = (await res.json()) as { data?: { name: string; category: string; language: string; components: unknown[] }[] };
      // Meta's ?name= is a PREFIX match: asking for "1st_hr_bi_9am_" returns
      // "1st_hr_bi_9am_11am" as well. Taking data[0] blindly meant copying a
      // DIFFERENT template under a different name, while reporting success —
      // the original was silently never copied at all.
      templateStructure = (data.data || []).find((t) => t.name === templateName) || null;
    }

    if (!templateStructure) {
      return error(404, "Could not fetch template structure from Meta", origin);
    }

    // Meta rejects template creation for an IMAGE/VIDEO/DOCUMENT header with
    // no example handle — reject up front with a clear message instead of
    // silently submitting a broken request per target and surfacing Meta's
    // generic "Invalid parameter" with no context.
    const needsHeaderImage = (templateStructure.components as { type?: string; format?: string }[]).some(
      (c) => c.type === "HEADER" && ["IMAGE", "VIDEO", "DOCUMENT"].includes(c.format || "")
    );
    if (needsHeaderImage && !headerImageUrl) {
      return error(400, "This template has an image/video/document header — a header image is required to copy it", origin);
    }

    // Submit template to each target WABA. Each target does up to 4
    // sequential Meta calls (download image, create upload session, upload
    // bytes, create template) — running these targets one at a time in a
    // `for` loop measured taking the full 60s Lambda timeout for 23 targets
    // (confirmed via CloudWatch: REPORT ... Status: timeout), well past API
    // Gateway's 29s hard cutoff, so the browser only ever saw a generic
    // "Request failed" with every target marked failed even though some may
    // have actually gone through on Meta's side. Same root cause and fix as
    // templates/fetch.ts: fan out concurrently instead, with a per-call
    // timeout so one stuck target can't stall the rest.
    const PER_CALL_TIMEOUT_MS = 8000;

    async function copyToTarget(targetWabaid: string): Promise<{ wabaid: string; status: string; error?: string }> {
      if (targetWabaid === sourceWabaid) {
        return { wabaid: targetWabaid, status: "skipped", error: "Same as source" };
      }

      try {
        // Deep clone components so we can modify per-target
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const components = JSON.parse(JSON.stringify(templateStructure!.components)) as any[];

        // Handle image/video/document headers — upload to Meta to get a file handle.
        // headerImageUrl is guaranteed present here (checked above); if the upload
        // itself fails, skip this target with a clear reason rather than submitting
        // the header with no example and letting Meta reject it generically.
        let headerUploadFailed = false;
        for (const comp of components) {
          if (comp.type === "HEADER" && ["IMAGE", "VIDEO", "DOCUMENT"].includes(comp.format)) {
            const handle = await uploadImageToMeta(headerImageUrl, targetAccessToken, PER_CALL_TIMEOUT_MS);
            if (handle) {
              comp.example = { header_handle: [handle] };
            } else {
              headerUploadFailed = true;
            }
          }
        }
        if (headerUploadFailed) {
          return { wabaid: targetWabaid, status: "failed", error: "Failed to upload header image to Meta" };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
        let createRes: Response;
        try {
          createRes = await fetch(
            `https://graph.facebook.com/v25.0/${targetWabaid}/message_templates`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${targetAccessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                name: templateStructure!.name,
                category: templateStructure!.category,
                language: templateStructure!.language,
                components,
              }),
              signal: controller.signal,
            }
          );
        } finally {
          clearTimeout(timer);
        }

        const createData = (await createRes.json()) as {
          id?: string;
          error?: {
            message: string;
            code: number;
            error_subcode?: number;
            error_user_title?: string;
            error_user_msg?: string;
            fbtrace_id?: string;
          };
        };

        if (createRes.ok && createData.id) {
          return { wabaid: targetWabaid, status: "submitted" };
        }

        // Meta's top-level error.message is almost always the same generic
        // "Invalid parameter" no matter the real cause — the actionable
        // reason (duplicate name, category mismatch, missing example field,
        // etc.) lives in error_user_title/error_user_msg, which the old code
        // discarded. Log the full object server-side too, since fbtrace_id
        // is what Meta support actually wants if this needs escalating.
        if (createData.error) {
          console.error(`Template copy failed for ${targetWabaid}:`, JSON.stringify(createData.error));
        }
        const detail = [createData.error?.error_user_title, createData.error?.error_user_msg]
          .filter(Boolean)
          .join(": ");
        return {
          wabaid: targetWabaid,
          status: "failed",
          error: detail || createData.error?.message || `HTTP ${createRes.status}`,
        };
      } catch (err) {
        return {
          wabaid: targetWabaid,
          status: "failed",
          error: err instanceof Error ? err.message : "Request failed",
        };
      }
    }

    const results = await Promise.all(
      (targetWabaIds as string[]).map((targetWabaid) => copyToTarget(targetWabaid))
    );

    return success({ results }, origin);
  } catch (err) {
    console.error("Template copy error:", err);
    return error(500, "Failed to copy template", origin);
  }
};

/**
 * Upload image to Meta via Resumable Upload API and return the file handle.
 * Steps: 1) Download image 2) Create upload session 3) Upload bytes 4) Get handle
 * Each step gets its own timeout so one hung network call can't stall the
 * whole target's chain when many targets are running concurrently.
 */
async function uploadImageToMeta(imageUrl: string, accessToken: string, timeoutMs: number): Promise<string | null> {
  const withTimeout = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // 1. Download the image
    const imgRes = await withTimeout(imageUrl, {});
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

    const sessionRes = await withTimeout(
      `https://graph.facebook.com/v25.0/${appId}/uploads?file_length=${fileSize}&file_type=${encodeURIComponent(contentType)}`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const sessionData = (await sessionRes.json()) as { id?: string; error?: { message: string } };
    if (!sessionData.id) {
      console.error("Upload session failed:", sessionData.error?.message);
      return null;
    }

    // 3. Upload the file bytes
    const uploadRes = await withTimeout(
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
