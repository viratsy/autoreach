import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { generateCampaignId } from "../../lib/campaign-id";
import { success, error, options } from "../../lib/response";
import { CampaignRecord } from "../../lib/types";

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

    return success({ campaignId, campaignName: record.campaignName }, origin);
  } catch (err) {
    console.error("Error creating campaign:", err);
    return error(500, "Failed to create campaign", origin);
  }
};
