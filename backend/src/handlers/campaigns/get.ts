import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { calculateActualCost } from "../../lib/pricing";
import { success, error, options } from "../../lib/response";

/**
 * GET /campaigns/{campaignId}
 * Returns campaign details + metrics.
 * Metrics come from pre-computed counters on the campaign record (fast, no messages scan).
 * For old campaigns without counters, falls back to paginated messages query.
 *
 * GET /campaigns/{campaignId}?status=failed&page=1&limit=50
 * Returns paginated message list filtered by status using GSI3.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    const statusFilter = event.queryStringParameters?.status;
    const page = parseInt(event.queryStringParameters?.page || "1");
    const limit = Math.min(parseInt(event.queryStringParameters?.limit || "50"), 200);

    // Get campaign record
    const campaignResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
      })
    );
    const campaign = campaignResult.Item;
    if (!campaign) return error(404, "Campaign not found", origin);

    // ── If status filter requested, return paginated message list ──────────
    if (statusFilter) {
      const allItems: Record<string, unknown>[] = [];
      let lastKey: Record<string, unknown> | undefined = undefined;

      // Use GSI3 to query by campaign+status efficiently
      do {
        const result = await docClient.send(
          new QueryCommand({
            TableName: TABLES.MESSAGES,
            IndexName: "GSI3",
            KeyConditionExpression: "GSI3PK = :gsi3pk",
            ExpressionAttributeValues: { ":gsi3pk": `CAMP#${campaignId}#STATUS#${statusFilter}` },
            ExclusiveStartKey: lastKey,
          })
        );
        allItems.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);

      // Paginate in-memory
      const start = (page - 1) * limit;
      const pageItems = allItems.slice(start, start + limit);

      return success({
        messages: pageItems.map((m) => {
          const sendingNum = campaign.selectedNumbers?.find(
            (n: { phoneNumberId: string }) => n.phoneNumberId === m.sendingNumberId
          );
          return {
            phone: m.phoneNumber,
            name: m.contactName,
            status: m.status,
            sendingNumber: sendingNum?.displayName || m.sendingNumberId || "-",
            errorCode: m.errorCode,
            sentAt: m.sentAt,
            repliedAt: m.repliedAt,
          };
        }),
        total: allItems.length,
        page,
        totalPages: Math.ceil(allItems.length / limit),
      }, origin);
    }

    // ── Metrics — use pre-computed counters if available ──────────────────
    let metrics: Record<string, number>;

    if (campaign.sentCount != null && campaign.deliveredCount != null) {
      // Fast path — counters written by send-worker + webhook-worker
      const s  = (campaign.sentCount      as number) || 0;
      const d  = (campaign.deliveredCount as number) || 0;
      const r  = (campaign.readCount      as number) || 0;
      const f  = (campaign.failedCount    as number) || 0;
      const sk = (campaign.skippedCount   as number) || 0;
      metrics = {
        total:     campaign.totalContacts || 0,
        sent:      s + d + r,
        delivered: d + r,
        read:      r,
        failed:    f,
        skipped:   sk,
        queued:    Math.max(0, (campaign.totalContacts || 0) - s - d - r - f - sk),
        replied:   (campaign.repliedCount as number) || 0,
      };
    } else {
      // Slow path — old campaign without counters, scan with pagination
      const allMessages: Record<string, unknown>[] = [];
      let lastKey: Record<string, unknown> | undefined = undefined;
      do {
        const result = await docClient.send(
          new QueryCommand({
            TableName: TABLES.MESSAGES,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}` },
            ProjectionExpression: "#s, repliedAt",
            ExpressionAttributeNames: { "#s": "status" },
            ExclusiveStartKey: lastKey,
          })
        );
        allMessages.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);

      const byStatus: Record<string, number> = {};
      for (const m of allMessages) { byStatus[m.status as string] = (byStatus[m.status as string] || 0) + 1; }
      const r = byStatus["read"] || 0;
      const d = byStatus["delivered"] || 0;
      const s = byStatus["sent"] || 0;
      metrics = {
        total:     allMessages.length,
        sent:      s + d + r,
        delivered: d + r,
        read:      r,
        failed:    byStatus["failed"]  || 0,
        skipped:   byStatus["skipped"] || 0,
        queued:    byStatus["queued"]  || 0,
        replied:   allMessages.filter((m) => m.repliedAt).length,
      };
    }

    const templateCategory = campaign.templateCategory || "utility";
    const cost = calculateActualCost(metrics.delivered, templateCategory);

    return success({
      campaign: {
        campaignId:     campaign.campaignId,
        campaignName:   campaign.campaignName,
        businessName:   campaign.businessName,
        selectedNumbers: campaign.selectedNumbers,
        templateName:   campaign.templateName,
        templateCategory,
        totalContacts:  campaign.totalContacts,
        scheduleDate:   campaign.scheduleDate,
        scheduleTime:   campaign.scheduleTime,
        status:         campaign.status,
        createdAt:      campaign.createdAt,
      },
      metrics,
      cost,
    }, origin);
  } catch (err) {
    console.error("Get campaign error:", err);
    return error(500, "Failed to get campaign", origin);
  }
};
