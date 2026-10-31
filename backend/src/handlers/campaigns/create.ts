import { APIGatewayProxyHandler } from "aws-lambda";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { createScheduledCampaign } from "../../lib/campaign-factory";

export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  const authEmail = getAuthEmail(event);
  if (!authEmail) return error(401, "Unauthorized", origin);

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
      workshop,
      batch,
      msg,
    } = body;

    if (!campaignPrefix || !businessId || !selectedNumbers?.length) {
      return error(400, "Missing required fields", origin);
    }

    const { campaignId, campaignName } = await createScheduledCampaign({
      campaignPrefix,
      businessId,
      businessName,
      selectedNumbers,
      templateName,
      templateCategory: body.templateCategory,
      templateMappings,
      parameterMapping,
      csvS3Key,
      headerImageUrl,
      numbersWithImageHeader,
      failureMode: body.failureMode,
      autoRetry: body.autoRetry,
      respectUnsubscribeList: body.respectUnsubscribeList,
      excludePaidUsers: body.excludePaidUsers,
      workshop,
      batch,
      msg,
      totalContacts,
      scheduleDate,
      scheduleTime,
      emailEnabled: body.emailEnabled === true,
      emailTemplateId: body.emailTemplateId || undefined,
      createdBy: authEmail,
    });

    return success({ campaignId, campaignName }, origin);
  } catch (err) {
    console.error("Error creating campaign:", err);
    return error(500, "Failed to create campaign", origin);
  }
};
