import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const scheduler = new SchedulerClient({});
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || "default";

/**
 * Cancel a scheduled campaign.
 * POST /campaigns/{campaignId}/cancel
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    // Get campaign
    const result = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = result.Item;
    if (!campaign) return error(404, "Campaign not found", origin);
    if (campaign.status !== "scheduled") return error(400, "Only scheduled campaigns can be cancelled", origin);

    // Delete EventBridge schedule
    try {
      await scheduler.send(
        new DeleteScheduleCommand({
          Name: `autoreach-${campaignId}`,
          GroupName: SCHEDULER_GROUP,
        })
      );
    } catch (err) {
      console.warn("Schedule delete failed (may already be gone):", err);
    }

    // Update status
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
        UpdateExpression: "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "cancelled",
          ":gsi2pk": "STATUS#cancelled",
          ":now": new Date().toISOString(),
        },
      })
    );

    return success({ message: "Campaign cancelled" }, origin);
  } catch (err) {
    console.error("Cancel error:", err);
    return error(500, "Failed to cancel campaign", origin);
  }
};
