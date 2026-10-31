import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, DeleteScheduleCommand, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { buildScheduleName } from "../../lib/campaign-factory";

const scheduler = new SchedulerClient({});
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || "default";
const SEND_FUNCTION_ARN = process.env.SEND_FUNCTION_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;

/**
 * Reschedule a scheduled campaign to a new date/time.
 * PUT /campaigns/{campaignId}/reschedule
 * Body: { scheduleDate: "2026-06-16", scheduleTime: "18:15" }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    const { scheduleDate, scheduleTime } = JSON.parse(event.body || "{}");
    if (!scheduleDate || !scheduleTime) return error(400, "scheduleDate and scheduleTime are required", origin);

    // Validate date format
    const istDateTime = new Date(`${scheduleDate}T${scheduleTime}:00+05:30`);
    if (isNaN(istDateTime.getTime())) return error(400, "Invalid date or time format", origin);
    if (istDateTime <= new Date()) return error(400, "Schedule time must be in the future", origin);

    // Get campaign
    const result = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = result.Item;
    if (!campaign) return error(404, "Campaign not found", origin);
    if (campaign.status !== "scheduled") return error(400, "Only scheduled campaigns can be rescheduled", origin);

    // Delete old EventBridge schedule
    try {
      await scheduler.send(
        new DeleteScheduleCommand({
          Name: buildScheduleName(campaignId),
          GroupName: SCHEDULER_GROUP,
        })
      );
    } catch (err) {
      console.warn("Old schedule delete failed (may already be gone):", err);
    }

    // Create new EventBridge schedule with updated time
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

    // Update campaign record
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
        UpdateExpression: "SET scheduleDate = :date, scheduleTime = :time, GSI2SK = :gsi2sk, updatedAt = :now",
        ExpressionAttributeValues: {
          ":date": scheduleDate,
          ":time": scheduleTime,
          ":gsi2sk": `${scheduleDate}#${scheduleTime}`,
          ":now": new Date().toISOString(),
        },
      })
    );

    return success({
      message: "Campaign rescheduled",
      scheduleDate,
      scheduleTime,
    }, origin);
  } catch (err) {
    console.error("Reschedule error:", err);
    return error(500, "Failed to reschedule campaign", origin);
  }
};
