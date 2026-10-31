import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { buildScheduleName } from "../../lib/campaign-factory";

const scheduler = new SchedulerClient({});
const SEND_FUNCTION_ARN = process.env.SEND_FUNCTION_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || "default";

// One HTTP call processes every id in parallel (Get + CreateSchedule + Update
// per campaign) — API Gateway REST APIs hard-kill at 29s regardless of the
// Lambda's own timeout, so this cap keeps a single request comfortably under
// that even in the worst case. Selecting more just means the frontend sends
// more than one bulk-approve call.
const MAX_IDS_PER_CALL = 100;

/**
 * Promotes a set of already-scheduled-date drafts (e.g. the current-batch
 * scheduler's unattended output) straight to "scheduled" — same effect as
 * opening each one in the edit wizard and hitting Save, minus the manual
 * per-campaign click. Only touches drafts that already carry a
 * scheduleDate/scheduleTime (the "one click to confirm" safety gate those
 * jobs rely on) and that time hasn't already passed.
 * POST /campaigns/bulk-approve
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
      return error(400, `Approve at most ${MAX_IDS_PER_CALL} campaigns per call`, origin);
    }

    const approved: string[] = [];
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
          if (campaign.status !== "draft") {
            skipped.push({ campaignId, reason: `Not a draft (status: ${campaign.status})` });
            return;
          }
          if (!campaign.scheduleDate || !campaign.scheduleTime) {
            skipped.push({ campaignId, reason: "No schedule date/time set" });
            return;
          }

          const istDateTime = new Date(`${campaign.scheduleDate}T${campaign.scheduleTime}:00+05:30`);
          if (isNaN(istDateTime.getTime()) || istDateTime <= new Date()) {
            skipped.push({ campaignId, reason: "Schedule time is in the past" });
            return;
          }

          const scheduleExpression = `at(${istDateTime.toISOString().replace(".000Z", "")})`;
          await scheduler.send(
            new CreateScheduleCommand({
              Name: buildScheduleName(campaignId),
              GroupName: SCHEDULER_GROUP,
              ScheduleExpression: scheduleExpression,
              ScheduleExpressionTimezone: "UTC",
              FlexibleTimeWindow: { Mode: "OFF" },
              Target: {
                Arn: SEND_FUNCTION_ARN,
                RoleArn: SCHEDULER_ROLE_ARN,
                Input: JSON.stringify({ campaignId }),
              },
              ActionAfterCompletion: "DELETE",
            })
          );

          await docClient.send(
            new UpdateCommand({
              TableName: TABLES.CAMPAIGNS,
              Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
              UpdateExpression: "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": "scheduled",
                ":gsi2pk": "STATUS#scheduled",
                ":now": new Date().toISOString(),
              },
            })
          );

          approved.push(campaignId);
        } catch (err) {
          console.error(`bulk-approve: failed for ${campaignId}`, err);
          skipped.push({ campaignId, reason: "Internal error" });
        }
      })
    );

    return success({ approved, skipped }, origin);
  } catch (err) {
    console.error("Bulk approve error:", err);
    return error(500, "Failed to bulk approve campaigns", origin);
  }
};
