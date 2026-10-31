import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

/**
 * Deletes a draft campaign outright. Only drafts — a scheduled/running/
 * completed campaign has a live EventBridge schedule or in-flight/sent
 * messages, so those go through cancel.ts instead, which unwinds that state
 * properly rather than just removing the record.
 * DELETE /campaigns/{campaignId}
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    const result = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = result.Item;
    if (!campaign) return error(404, "Campaign not found", origin);
    if (campaign.status !== "draft") return error(400, "Only draft campaigns can be deleted", origin);

    await docClient.send(
      new DeleteCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );

    return success({ campaignId, deleted: true }, origin);
  } catch (err) {
    console.error("Delete campaign error:", err);
    return error(500, "Failed to delete campaign", origin);
  }
};
