import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { generateCampaignId, buildCampaignName } from "../../lib/campaign-id";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { CampaignRecord } from "../../lib/types";
import { estimateCost } from "../../lib/pricing";

/**
 * Duplicate a campaign - copies settings into a new draft.
 * POST /campaigns/{campaignId}/duplicate
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  const authEmail = getAuthEmail(event);
  if (!authEmail) return error(401, "Unauthorized", origin);

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

    // Create new campaign as draft.
    //
    // The display prefix comes from workshop/batch/msg — the same parts the
    // name is built from everywhere else — so a duplicate arrives with the
    // original's name and a fresh suffix, and stays consistent with the
    // grouping fields it just inherited. Falling back to the original's own
    // name (minus its suffix) covers older campaigns saved before those fields
    // existed.
    //
    // The name used to be set to the generated id, which is sanitized to
    // lowercase underscores — so duplicating "AICA B22_Main_1st Reminder_49925c"
    // produced "aica_b22_main_1st_reminder_090663" and there was no way to put
    // the readable name back.
    const displayPrefix =
      [original.workshop, original.batch, original.msg].filter(Boolean).join("_") ||
      String(original.campaignName || "").split("_").slice(0, -1).join("_") ||
      "copy";

    const newId = generateCampaignId(displayPrefix);
    const now = new Date().toISOString();

    const newCampaign: CampaignRecord = {
      PK: `CAMP#${newId}`,
      SK: "METADATA",
      GSI1PK: `BIZ#${original.businessId}`,
      GSI1SK: now,
      GSI2PK: "STATUS#draft",
      GSI2SK: "#",
      campaignId: newId,
      campaignName: buildCampaignName(displayPrefix, newId),
      businessId: original.businessId,
      businessName: original.businessName,
      selectedNumbers: original.selectedNumbers,
      templateName: original.templateName,
      templateCategory: original.templateCategory,
      templateMappings: original.templateMappings || {},
      parameterMapping: original.parameterMapping || {},
      headerImageUrl: original.headerImageUrl || "",
      numbersWithImageHeader: original.numbersWithImageHeader || [],
      csvS3Key: original.csvS3Key,
      totalContacts: original.totalContacts,
      workshop: original.workshop || undefined,
      batch: original.batch || undefined,
      msg: original.msg || undefined,
      failureMode: original.failureMode || "reroute",
      autoRetry: original.autoRetry !== false,
      respectUnsubscribeList: original.respectUnsubscribeList !== false,
      excludePaidUsers: original.excludePaidUsers !== false,
      retryCount: 0,
      estimatedCost: estimateCost(original.totalContacts || 0, original.templateCategory || "UTILITY"),
      scheduleDate: "",
      scheduleTime: "",
      status: "draft",
      createdBy: authEmail,
      createdAt: now,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({ TableName: TABLES.CAMPAIGNS, Item: newCampaign })
    );

    return success({ campaignId: newId, campaignName: newCampaign.campaignName }, origin);
  } catch (err) {
    console.error("Duplicate campaign error:", err);
    return error(500, "Failed to duplicate campaign", origin);
  }
};
