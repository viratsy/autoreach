import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

/**
 * List all campaigns with optional status filter.
 * GET /campaigns?status=scheduled
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLES.CAMPAIGNS,
        FilterExpression: "SK = :sk",
        ExpressionAttributeValues: { ":sk": "METADATA" },
      })
    );

    const campaigns = (result.Items || []).map((item) => ({
      campaignId: item.campaignId,
      campaignName: item.campaignName,
      businessId: item.businessId,
      businessName: item.businessName,
      selectedNumbers: item.selectedNumbers,
      templateName: item.templateName,
      totalContacts: item.totalContacts,
      scheduleDate: item.scheduleDate,
      scheduleTime: item.scheduleTime,
      status: item.status,
      createdAt: item.createdAt,
    }));

    // Compute stats
    const stats = {
      totalCampaigns: campaigns.length,
      scheduled: campaigns.filter((c) => c.status === "scheduled").length,
      running: campaigns.filter((c) => c.status === "running").length,
      completed: campaigns.filter((c) => c.status === "completed").length,
      failed: campaigns.filter((c) => c.status === "failed").length,
    };

    return success({ campaigns, stats }, origin);
  } catch (err) {
    console.error("List campaigns error:", err);
    return error(500, "Failed to list campaigns", origin);
  }
};
