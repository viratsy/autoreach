import { Handler } from "aws-lambda";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { createNotification } from "../notifications/index";

/**
 * Nightly safety net (runs 1 AM IST via EventBridge): force-closes any campaign
 * still stuck in "running" from a previous calendar day. Campaigns are expected
 * to finish same-day; if one is still "running" after midnight, something went
 * wrong with the completion check in send-worker.ts (e.g. a missed final tick).
 * Whatever was sent/delivered/failed so far stands — this just stops the status
 * from lingering as "running" forever.
 */
export const handler: Handler = async () => {
  const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  console.log(`Auto-stop sweep started. Today (IST): ${todayIST}`);

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLES.CAMPAIGNS,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": "STATUS#running" },
      })
    );

    const stuckCampaigns = (result.Items || []).filter((c) => (c.scheduleDate || "") < todayIST);
    console.log(`Found ${stuckCampaigns.length} running campaign(s) from a previous day`);

    for (const campaign of stuckCampaigns) {
      const now = new Date().toISOString();
      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: campaign.PK, SK: "METADATA" },
          UpdateExpression: "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": "completed", ":gsi2pk": "STATUS#completed", ":now": now },
        })
      );

      console.log(`Auto-stopped campaign ${campaign.campaignId} (scheduled ${campaign.scheduleDate})`);

      await createNotification({
        type: "campaign_stuck",
        businessId: campaign.businessId || "",
        businessName: campaign.businessName || "",
        phoneNumberId: "",
        phoneDisplayName: "",
        campaignId: campaign.campaignId,
        errorMessage: `Campaign "${campaign.campaignName}" was still "running" from ${campaign.scheduleDate} and was auto-stopped at day end.`,
      });
    }

    console.log("Auto-stop sweep completed");
  } catch (err) {
    console.error("Auto-stop sweep error:", err);
  }
};
