import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
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
    const metrics = {
      total: messages.length,
      queued: messages.filter((m) => m.status === "queued").length,
      sent: messages.filter((m) => m.status === "sent").length,
      delivered: messages.filter((m) => m.status === "delivered").length,
      read: messages.filter((m) => m.status === "read").length,
      failed: messages.filter((m) => m.status === "failed").length,
      replied: messages.filter((m) => m.repliedAt).length,
    };

    // Recent messages (last 50)
    const recentMessages = messages
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .slice(0, 50)
      .map((m) => ({
        phone: m.phoneNumber,
        name: m.contactName,
        status: m.status,
        sendingNumber: m.sendingNumberId,
        errorCode: m.errorCode,
        sentAt: m.sentAt,
        repliedAt: m.repliedAt,
      }));

    return success({
      campaign: {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        businessName: campaign.businessName,
        selectedNumbers: campaign.selectedNumbers,
        templateName: campaign.templateName,
        totalContacts: campaign.totalContacts,
        scheduleDate: campaign.scheduleDate,
        scheduleTime: campaign.scheduleTime,
        status: campaign.status,
        createdAt: campaign.createdAt,
      },
      metrics,
      recentMessages,
    }, origin);
  } catch (err) {
    console.error("Get campaign error:", err);
    return error(500, "Failed to get campaign", origin);
  }
};
