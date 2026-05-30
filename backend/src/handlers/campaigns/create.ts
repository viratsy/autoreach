import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { docClient, TABLES } from "../../lib/dynamo";
import { generateCampaignId } from "../../lib/campaign-id";
import { success, error, options } from "../../lib/response";
import { CampaignRecord } from "../../lib/types";

const scheduler = new SchedulerClient({});
const SEND_FUNCTION_ARN = process.env.SEND_FUNCTION_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || "default";

export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const body = JSON.parse(event.body || "{}");
    const {
      campaignPrefix,
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
    } = body;

    if (!campaignPrefix || !businessId || !selectedNumbers?.length) {
      return error(400, "Missing required fields", origin);
    }

    const campaignId = generateCampaignId(campaignPrefix);
    const status = scheduleDate && scheduleTime ? "scheduled" : "draft";
    const now = new Date().toISOString();

    const record: CampaignRecord = {
      PK: `CAMP#${campaignId}`,
      SK: "METADATA",
      GSI1PK: `BIZ#${businessId}`,
      GSI1SK: now,
      GSI2PK: `STATUS#${status}`,
      GSI2SK: `${scheduleDate}#${scheduleTime}`,
      campaignId,
      campaignName: `${campaignPrefix}_${campaignId.split("_").pop()}`,
      businessId,
      businessName,
      selectedNumbers,
      templateName: templateName || "",
      templateMappings: templateMappings || {},
      parameterMapping: parameterMapping || {},
      csvS3Key: csvS3Key || "",
      headerImageUrl: headerImageUrl || "",
      numbersWithImageHeader: numbersWithImageHeader || [],
      totalContacts: totalContacts || 0,
      scheduleDate: scheduleDate || "",
      scheduleTime: scheduleTime || "",
      status,
      createdBy: event.requestContext.authorizer?.claims?.sub || "system",
      createdAt: now,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({ TableName: TABLES.CAMPAIGNS, Item: record })
    );

    // Create EventBridge Schedule if scheduled
    if (status === "scheduled" && scheduleDate && scheduleTime) {
      // Convert IST to UTC for EventBridge (IST = UTC+5:30)
      const istDateTime = new Date(`${scheduleDate}T${scheduleTime}:00+05:30`);
      const scheduleExpression = `at(${istDateTime.toISOString().replace('.000Z', '')})`;

      await scheduler.send(
        new CreateScheduleCommand({
          Name: `autoreach-${campaignId}`,
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
    console.error("Error creating campaign:", err);
    return error(500, "Failed to create campaign", origin);
  }
};
