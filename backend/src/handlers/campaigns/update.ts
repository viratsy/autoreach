import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { CampaignRecord } from "../../lib/types";
import { getAuthEmail } from "../../lib/auth";
import { estimateCost } from "../../lib/pricing";
import { buildScheduleName } from "../../lib/campaign-factory";
import { buildCampaignName } from "../../lib/campaign-id";

const scheduler = new SchedulerClient({});
const SEND_FUNCTION_ARN = process.env.SEND_FUNCTION_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || "default";

/**
 * Edit a draft campaign in place — same field shape as POST /campaigns, but
 * overwrites the existing record instead of minting a new campaignId. Only
 * drafts can be edited this way; a scheduled/running/completed campaign's
 * content is locked (reschedule.ts covers changing just the send time).
 * PUT /campaigns/{campaignId}
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  const authEmail = getAuthEmail(event);
  if (!authEmail) return error(401, "Unauthorized", origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    const existingResult = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const existing = existingResult.Item as CampaignRecord | undefined;
    if (!existing) return error(404, "Campaign not found", origin);
    if (existing.status !== "draft") return error(400, "Only draft campaigns can be edited", origin);

    const body = JSON.parse(event.body || "{}");
    const {
      businessId,
      businessName,
      selectedNumbers,
      templateName,
      templateMappings,
      parameterMapping,
      headerImageUrl,
      numbersWithImageHeader,
      csvS3Key,
      totalContacts,
      scheduleDate,
      scheduleTime,
      workshop,
      batch,
      msg,
    } = body;

    if (!businessId || !selectedNumbers?.length) {
      return error(400, "Missing required fields", origin);
    }

    const status = scheduleDate && scheduleTime ? "scheduled" : "draft";
    const now = new Date().toISOString();

    // Renaming a draft happens through workshop/batch/msg, the same three
    // fields the name is built from at creation — the Review step already lets
    // you edit them and previews the resulting name. Recomputing here is what
    // makes that edit stick: this handler used to spread `...existing` and
    // never touch campaignName, so changing those fields updated the Total Cost
    // grouping while the visible name silently kept the old one. The id (and
    // so the trailing suffix) never changes, so a rename can't break links.
    const namePrefix = [workshop, batch, msg].filter(Boolean).join("_") || body.campaignPrefix || "";
    const campaignName = namePrefix
      ? buildCampaignName(namePrefix, campaignId)
      : existing.campaignName;

    const record: CampaignRecord = {
      ...existing,
      campaignName,
      GSI2PK: `STATUS#${status}`,
      GSI2SK: `${scheduleDate || ""}#${scheduleTime || ""}`,
      businessId,
      businessName,
      selectedNumbers,
      templateName: templateName || "",
      templateCategory: body.templateCategory || "UTILITY",
      templateMappings: templateMappings || {},
      parameterMapping: parameterMapping || {},
      csvS3Key: csvS3Key || "",
      headerImageUrl: headerImageUrl || "",
      numbersWithImageHeader: numbersWithImageHeader || [],
      failureMode: body.failureMode || "reroute",
      autoRetry: body.autoRetry !== false,
      respectUnsubscribeList: body.respectUnsubscribeList !== false,
      excludePaidUsers: body.excludePaidUsers !== false,
      emailEnabled: body.emailEnabled === true,
      emailTemplateId: body.emailTemplateId || undefined,
      workshop: workshop || undefined,
      batch: batch || undefined,
      msg: msg || undefined,
      totalContacts: totalContacts || 0,
      scheduleDate: scheduleDate || "",
      scheduleTime: scheduleTime || "",
      estimatedCost: estimateCost(totalContacts || 0, body.templateCategory || "UTILITY"),
      status,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({ TableName: TABLES.CAMPAIGNS, Item: record })
    );

    if (status === "scheduled" && scheduleDate && scheduleTime) {
      const istDateTime = new Date(`${scheduleDate}T${scheduleTime}:00+05:30`);
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
    }

    return success({ campaignId, campaignName: record.campaignName }, origin);
  } catch (err) {
    console.error("Error updating campaign:", err);
    return error(500, "Failed to update campaign", origin);
  }
};
