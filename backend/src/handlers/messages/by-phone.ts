import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

/**
 * Full send history for one recipient phone number, across every campaign
 * that has ever messaged them — powers a per-contact timeline (status
 * progression queued -> sent -> delivered -> read, plus replies) without
 * needing to already know which campaign(s) reached them. Backed by GSI4
 * (GSI4PK = PHONE#<digits>), the same index trackCampaignReply() in
 * webhook-worker.ts already uses to find a contact's messages.
 * GET /messages/by-phone?phone=919650636663
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const rawPhone = event.queryStringParameters?.phone;
    if (!rawPhone) return error(400, "phone is required", origin);
    const phone = rawPhone.replace(/\D/g, "");
    if (!phone) return error(400, "phone must contain digits", origin);

    // Must paginate: a Query returns at most 1MB per page, and these rows carry
    // the whole csvRow (~1KB each), so a heavily-messaged contact silently lost
    // everything past ~900 messages — no error, just a short timeline.
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLES.MESSAGES,
          IndexName: "GSI4",
          KeyConditionExpression: "GSI4PK = :pk",
          ExpressionAttributeValues: { ":pk": `PHONE#${phone}` },
          ScanIndexForward: false, // newest first — most recent activity is what gets checked
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    // Test-send tracking rows (PK "TESTSEND#<messageId>") never carry GSI4PK
    // in the first place, but filtering defensively here costs nothing and
    // guards against that changing later.
    const messages = items.filter((m) => (m.PK as string)?.startsWith("CAMP#"));

    // The Messages table only knows a campaignId (via PK) — campaignName,
    // businessName and templateName all live on the Campaign record itself.
    const campaignIds = Array.from(new Set(messages.map((m) => (m.PK as string).replace("CAMP#", ""))));
    const campaignInfo = new Map<string, { campaignName: string; businessName: string; templateName: string }>();

    const CHUNK = 100; // BatchGetItem's per-request key cap
    for (let i = 0; i < campaignIds.length; i += CHUNK) {
      const slice = campaignIds.slice(i, i + CHUNK);
      const res = await docClient.send(
        new BatchGetCommand({
          RequestItems: {
            [TABLES.CAMPAIGNS]: { Keys: slice.map((id) => ({ PK: `CAMP#${id}`, SK: "METADATA" })) },
          },
        })
      );
      for (const item of res.Responses?.[TABLES.CAMPAIGNS] || []) {
        campaignInfo.set(item.campaignId as string, {
          campaignName: (item.campaignName as string) || (item.campaignId as string),
          businessName: (item.businessName as string) || "",
          templateName: (item.templateName as string) || "",
        });
      }
    }

    const timeline = messages.map((m) => {
      const campaignId = (m.PK as string).replace("CAMP#", "");
      const info = campaignInfo.get(campaignId);
      return {
        campaignId,
        campaignName: info?.campaignName || campaignId,
        businessName: info?.businessName || "",
        templateName: info?.templateName || "",
        contactName: m.contactName || "",
        sendingNumberId: m.sendingNumberId || "",
        status: m.status || "unknown",
        errorCode: m.errorCode || null,
        sentAt: m.sentAt || "",
        updatedAt: m.updatedAt || "",
        repliedAt: m.repliedAt || null,
      };
    });

    return success({ phone, timeline }, origin);
  } catch (err) {
    console.error("Messages by-phone error:", err);
    return error(500, "Failed to load message history", origin);
  }
};
