import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { generateCampaignId } from "../../lib/campaign-id";
import { success, error, options } from "../../lib/response";

/**
 * Duplicate a campaign - copies settings into a new draft.
 * POST /campaigns/{campaignId}/duplicate
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    // Get original campaign
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
      })
    );

    const original = result.Item;
    if (!original) return error(404, "Campaign not found", origin);

    // Create new campaign as draft
    const newId = generateCampaignId(original.campaignName.split("_").slice(0, -1).join("_") || "copy");
    const now = new Date().toISOString();

    const newCampaign = {
      PK: `CAMP#${newId}`,
      SK: "METADATA",
      GSI1PK: `BIZ#${original.businessId}`,
      GSI1SK: now,
      GSI2PK: "STATUS#draft",
      GSI2SK: "#",
      campaignId: newId,
      campaignName: newId,
      businessId: original.businessId,
      businessName: original.businessName,
      selectedNumbers: original.selectedNumbers,
      templateName: original.templateName,
      templateMappings: original.templateMappings || {},
      parameterMapping: original.parameterMapping || {},
      headerImageUrl: original.headerImageUrl || "",
      numbersWithImageHeader: original.numbersWithImageHeader || [],
      csvS3Key: original.csvS3Key,
      totalContacts: original.totalContacts,
      scheduleDate: "",
      scheduleTime: "",
      status: "draft",
      createdBy: event.requestContext.authorizer?.claims?.sub || "system",
      createdAt: now,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({ TableName: TABLES.CAMPAIGNS, Item: newCampaign })
    );

    return success({ campaignId: newId, campaignName: newId }, origin);
  } catch (err) {
    console.error("Duplicate campaign error:", err);
    return error(500, "Failed to duplicate campaign", origin);
  }
};
