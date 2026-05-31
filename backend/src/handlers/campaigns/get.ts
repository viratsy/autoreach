import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { calculateActualCost } from "../../lib/pricing";
import { success, error, options } from "../../lib/response";

/**
 * Get campaign details with message metrics.
 * GET /campaigns/{campaignId}
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    // Get campaign record
    const campaignResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
      })
    );

    const campaign = campaignResult.Item;
    if (!campaign) return error(404, "Campaign not found", origin);

    // Get message stats
    const messagesResult = await docClient.send(
      new QueryCommand({
        TableName: TABLES.MESSAGES,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}` },
      })
    );

    const messages = messagesResult.Items || [];
    // Metrics - cumulative (read includes delivered, delivered includes sent)
    // v2: fixed cumulative counting
    const failedCount = messages.filter((m) => m.status === "failed").length;
    const sentOrBetter = messages.filter((m) => m.status !== "failed" && m.status !== "queued").length;
    const deliveredOrBetter = messages.filter((m) => m.status === "delivered" || m.status === "read").length;
    const readCount = messages.filter((m) => m.status === "read").length;
    const repliedCount = messages.filter((m) => m.repliedAt).length;

    const metrics = {
      total: messages.length,
      sent: sentOrBetter,
      delivered: deliveredOrBetter,
      read: readCount,
      failed: failedCount,
      replied: repliedCount,
      queued: messages.filter((m) => m.status === "queued").length,
    };

    // Recent messages (last 50)
    const recentMessages = messages
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .slice(0, 50)
      .map((m) => {
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
      });

    // Calculate cost
    const templateCategory = campaign.templateCategory || "utility";
    const cost = calculateActualCost(metrics.delivered, templateCategory);

    return success({
      campaign: {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        businessName: campaign.businessName,
        selectedNumbers: campaign.selectedNumbers,
        templateName: campaign.templateName,
        templateCategory,
        totalContacts: campaign.totalContacts,
        scheduleDate: campaign.scheduleDate,
        scheduleTime: campaign.scheduleTime,
        status: campaign.status,
        createdAt: campaign.createdAt,
      },
      metrics,
      cost,
      recentMessages,
    }, origin);
  } catch (err) {
    console.error("Get campaign error:", err);
    return error(500, "Failed to get campaign", origin);
  }
};
