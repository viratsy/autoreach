import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { buildScheduleName } from "../../lib/campaign-factory";

const scheduler = new SchedulerClient({});
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || "default";

/**
 * Cancel a scheduled campaign.
 * POST /campaigns/{campaignId}/cancel
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    // Get campaign
    const result = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = result.Item;
    if (!campaign) return error(404, "Campaign not found", origin);
    
    // Handle running campaigns — stop and mark as cancelled. Must be
    // "cancelled" specifically, not "completed": send-worker.ts's per-batch
    // check that skips already-queued SQS messages for a stopped campaign
    // only matches status === "cancelled" — marking it "completed" instead
    // (as this used to) left every batch already in flight to keep sending
    // regardless, so "Stop" only updated the dashboard label without
    // actually stopping anything still queued.
    // ConditionExpression guards against a concurrent auto-stop / send-worker
    // completion flipping the status between our Get and this Update.
    if (campaign.status === "running") {
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: TABLES.CAMPAIGNS,
            Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
            UpdateExpression: "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now, completedAt = :now",
            ConditionExpression: "#status = :expected",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":status": "cancelled",
              ":gsi2pk": "STATUS#cancelled",
              ":now": new Date().toISOString(),
              ":expected": "running",
            },
          })
        );
        return success({ message: "Campaign stopped" }, origin);
      } catch (err) {
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
          return error(409, "Campaign status changed concurrently — please refresh and try again", origin);
        }
        throw err;
      }
    }

    if (campaign.status !== "scheduled") return error(400, "Only scheduled or running campaigns can be stopped", origin);

    // Delete EventBridge schedule
    try {
      await scheduler.send(
        new DeleteScheduleCommand({
          Name: buildScheduleName(campaignId),
          GroupName: SCHEDULER_GROUP,
        })
      );
    } catch (err) {
      console.warn("Schedule delete failed (may already be gone):", err);
    }

    // Update status
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now",
          ConditionExpression: "#status = :expected",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "cancelled",
            ":gsi2pk": "STATUS#cancelled",
            ":now": new Date().toISOString(),
            ":expected": "scheduled",
          },
        })
      );
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return error(409, "Campaign status changed concurrently — please refresh and try again", origin);
      }
      throw err;
    }

    return success({ message: "Campaign cancelled" }, origin);
  } catch (err) {
    console.error("Cancel error:", err);
    return error(500, "Failed to cancel campaign", origin);
  }
};
