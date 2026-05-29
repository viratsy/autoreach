import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { docClient, TABLES } from "../../lib/dynamo";
import { distributeContacts } from "../../lib/round-robin";
import { success, error } from "../../lib/response";
import { CSVContact, CampaignRecord } from "../../lib/types";

const s3 = new S3Client({});

/**
 * Triggered by EventBridge Scheduler at campaign schedule time.
 * Fetches CSV from S3, distributes contacts via round-robin,
 * sends messages through Meta API, and stores message records.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { campaignId } = JSON.parse(event.body || "{}");

    // Get campaign record
    const campaignResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
      })
    );

    const campaign = campaignResult.Item as CampaignRecord | undefined;
    if (!campaign) return error(404, "Campaign not found");

    // Update status to running
    await updateCampaignStatus(campaignId, "running");

    // Fetch CSV from S3
    const contacts = await fetchCSVFromS3(campaign.csvS3Key);

    // Distribute contacts across numbers (round-robin)
    const distributed = distributeContacts(contacts, campaign.selectedNumbers);

    // Send messages
    let sentCount = 0;
    let failedCount = 0;

    for (const { contact, assignedNumber } of distributed) {
      try {
        const metaMessageId = await sendWhatsAppMessage(
          campaign,
          contact,
          assignedNumber.phoneNumberId
        );

        // Store message record
        await docClient.send(
          new PutCommand({
            TableName: TABLES.MESSAGES,
            Item: {
              PK: `CAMP#${campaignId}`,
              SK: `MSG#${contact.phone}`,
              GSI1PK: `METAMSG#${metaMessageId}`,
              GSI1SK: `CAMP#${campaignId}`,
              phoneNumber: contact.phone,
              contactName: contact.name || "",
              sendingNumberId: assignedNumber.phoneNumberId,
              metaMessageId,
              status: "sent",
              repliedAt: null,
              errorCode: null,
              sentAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          })
        );

        sentCount++;
      } catch (err) {
        console.error(`Failed to send to ${contact.phone}:`, err);
        failedCount++;
      }
    }

    // Update campaign status
    const finalStatus = failedCount === contacts.length ? "failed" : "completed";
    await updateCampaignStatus(campaignId, finalStatus);

    return success({ sent: sentCount, failed: failedCount });
  } catch (err) {
    console.error("Campaign send error:", err);
    return error(500, "Campaign execution failed");
  }
};

async function updateCampaignStatus(campaignId: string, status: string) {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.CAMPAIGNS,
      Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
      UpdateExpression: "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": status,
        ":gsi2pk": `STATUS#${status}`,
        ":now": new Date().toISOString(),
      },
    })
  );
}

async function fetchCSVFromS3(s3Key: string): Promise<CSVContact[]> {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: process.env.CSV_BUCKET!,
      Key: s3Key,
    })
  );

  const csvText = await result.Body!.transformToString();
  const lines = csvText.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    const contact: CSVContact = { phone: "" };
    headers.forEach((header, i) => {
      contact[header] = values[i];
    });
    contact.phone = contact.phone || "";
    return contact;
  });
}

async function sendWhatsAppMessage(
  campaign: CampaignRecord,
  contact: CSVContact,
  phoneNumberId: string
): Promise<string> {
  // Build template parameters from mapping
  const parameters = Object.entries(campaign.parameterMapping)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, csvHeader]) => ({
      type: "text",
      text: contact[csvHeader] || "",
    }));

  // Get the template name for this number (may be mapped differently)
  const templateName =
    campaign.templateMappings[phoneNumberId] || campaign.templateName;

  const accessToken = process.env[`TOKEN_${phoneNumberId}`] || process.env.META_ACCESS_TOKEN;

  const response = await fetch(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: contact.phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters,
            },
          ],
        },
      }),
    }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Meta API error: ${JSON.stringify(data)}`);
  }

  return data.messages[0].id;
}
