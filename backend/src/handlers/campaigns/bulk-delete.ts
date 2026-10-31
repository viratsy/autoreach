import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { buildScheduleName } from "../../lib/campaign-factory";

const scheduler = new SchedulerClient({});
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || "default";

// Same per-call cap as bulk-approve.ts, for the same reason — API Gateway
// REST APIs hard-kill at 29s regardless of the Lambda's own timeout.
const MAX_IDS_PER_CALL = 100;

/**
 * Removes a set of drafts and/or scheduled campaigns from the list — same
 * per-status rule as the single-campaign delete.ts/cancel.ts endpoints, just
 * batched: a draft has no live schedule or sent messages yet, so it's
 * deleted outright; a scheduled campaign has a live EventBridge schedule, so
 * it's cancelled instead (schedule removed, status set to "cancelled") the
 * same way cancel.ts does, rather than deleting its record. Running/
 * completed/failed/cancelled campaigns are skipped — those go through
 * cancel.ts's "stop" path or aren't touchable at all.
 * POST /campaigns/bulk-delete
 * Body: { campaignIds: string[] }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const { campaignIds } = JSON.parse(event.body || "{}") as { campaignIds?: string[] };
    if (!Array.isArray(campaignIds) || campaignIds.length === 0) {
      return error(400, "campaignIds is required", origin);
    }
    if (campaignIds.length > MAX_IDS_PER_CALL) {
      return error(400, `Delete at most ${MAX_IDS_PER_CALL} campaigns per call`, origin);
    }

    const deleted: string[] = [];
    const cancelled: string[] = [];
    const skipped: { campaignId: string; reason: string }[] = [];

    await Promise.all(
      campaignIds.map(async (campaignId) => {
        try {
          const result = await docClient.send(
            new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
          );
          const campaign = result.Item;
          if (!campaign) {
            skipped.push({ campaignId, reason: "Not found" });
            return;
          }

          if (campaign.status === "draft") {
            await docClient.send(
              new DeleteCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
            );
            deleted.push(campaignId);
            return;
          }

          if (campaign.status === "scheduled") {
            try {
              await scheduler.send(
                new DeleteScheduleCommand({ Name: buildScheduleName(campaignId), GroupName: SCHEDULER_GROUP })
              );
            } catch (err) {
              console.warn(`bulk-delete: schedule delete failed for ${campaignId} (may already be gone):`, err);
            }

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
              cancelled.push(campaignId);
            } catch (err) {
              if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
                skipped.push({ campaignId, reason: "Status changed concurrently — please refresh and try again" });
                return;
              }
              throw err;
            }
            return;
          }

          skipped.push({ campaignId, reason: `Not a draft or scheduled campaign (status: ${campaign.status})` });
        } catch (err) {
          console.error(`bulk-delete: failed for ${campaignId}`, err);
          skipped.push({ campaignId, reason: "Internal error" });
        }
      })
    );

    return success({ deleted, cancelled, skipped }, origin);
  } catch (err) {
    console.error("Bulk delete error:", err);
    return error(500, "Failed to bulk delete campaigns", origin);
  }
};
