import { Handler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { docClient, TABLES } from "../../lib/dynamo";
import { CSVContact, CampaignRecord } from "../../lib/types";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const QUEUE_URL = process.env.SEND_QUEUE_URL!;
const BATCH_SIZE = 200;

/**
 * Orchestrator: Triggered by EventBridge Scheduler.
 * 1. Checks template category (aborts if MARKETING)
 * 2. Reads CSV from S3
 * 3. Distributes contacts round-robin across numbers
 * 4. Pushes batches of 200 to SQS for parallel processing
 */
export const handler: Handler = async (event) => {
  console.log("Send orchestrator invoked:", JSON.stringify(event));

  try {
    const campaignId = event.campaignId || JSON.parse(event.body || "{}").campaignId;
    if (!campaignId) {
      console.error("No campaignId");
      return;
    }

    // Get campaign
    const campaignResult = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = campaignResult.Item as CampaignRecord | undefined;
    if (!campaign) {
      console.error("Campaign not found:", campaignId);
      return;
    }

    // Update status to running
    await updateCampaignStatus(campaignId, "running");

    // Get business token
    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${campaign.businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    const accessToken = business?.accessToken || "";
    const provider = (business?.provider as string) || "meta";
    // Server-side source of truth for per-number secrets (apiKey/endpoint) — never trust the
    // client-supplied campaign.selectedNumbers for these, since they came from a frontend request.
    const bizNumbersById = new Map(
      ((business?.phoneNumbers || []) as { phoneNumberId: string; wabaid?: string; apiKey?: string; source?: string; endpoint?: string }[])
        .map((pn) => [pn.phoneNumberId, pn])
    );

    // SAFETY: Check template category on ALL numbers before sending.
    // Only meaningful for Meta — AiSensy/WATI have no equivalent category concept.
    const healthyNumbers: typeof campaign.selectedNumbers = [];
    const marketingNumbers: string[] = [];

    for (const number of campaign.selectedNumbers) {
      const wabaid = bizNumbersById.get(number.phoneNumberId)?.wabaid;
      if (provider === "meta" && wabaid && accessToken) {
        try {
          const tplRes = await fetch(
            `https://graph.facebook.com/v25.0/${wabaid}/message_templates?name=${campaign.templateName}&limit=1`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const tplData = (await tplRes.json()) as { data?: { category: string }[] };
          if (tplData.data?.[0]?.category === "MARKETING") {
            marketingNumbers.push(number.phoneNumberId);
            console.log(`Number ${number.phoneNumberId} has MARKETING template`);
          } else {
            healthyNumbers.push(number);
          }
        } catch {
          healthyNumbers.push(number); // If check fails, assume healthy
        }
      } else {
        healthyNumbers.push(number);
      }
    }

    const failureMode = (campaign as unknown as { failureMode?: string }).failureMode || "reroute";

    if (healthyNumbers.length === 0) {
      console.error("ABORTED: All numbers have MARKETING template");
      await updateCampaignStatus(campaignId, "failed");
      return { error: "All numbers have MARKETING template" };
    }

    if (marketingNumbers.length > 0) {
      console.log(`${marketingNumbers.length} numbers are MARKETING. Mode: ${failureMode}. Using ${healthyNumbers.length} healthy numbers.`);
    }

    // Use only healthy numbers for distribution
    const activeNumbers = healthyNumbers;

    // Read CSV
    const contacts = await fetchCSVFromS3(campaign.csvS3Key);
    console.log(`Read ${contacts.length} contacts from CSV`);

    // Distribute round-robin across healthy numbers only
    const numberCount = activeNumbers.length;
    const STAGGER_MINUTES = parseInt(process.env.STAGGER_MINUTES || "1");
    const batches: {
      contacts: CSVContact[];
      phoneNumberId: string;
      displayName: string;
      wabaid?: string;
      apiKey?: string;
      source?: string;
      endpoint?: string;
      delaySeconds: number;
    }[] = [];

    // Group contacts by assigned number
    const perNumber: Record<string, CSVContact[]> = {};
    contacts.forEach((contact, i) => {
      const number = activeNumbers[i % numberCount];
      if (!perNumber[number.phoneNumberId]) perNumber[number.phoneNumberId] = [];
      perNumber[number.phoneNumberId].push(contact);
    });

    // Split each number's contacts into batches of BATCH_SIZE
    // Each number gets a staggered SQS delay so they don't all start simultaneously.
    // Number 0 starts at 0s, Number 1 at STAGGER_MINUTES*60s, etc.
    const numberOrder = Object.keys(perNumber);
    for (const [numberIndex, phoneNumberId] of numberOrder.entries()) {
      const numberContacts = perNumber[phoneNumberId];
      const number = activeNumbers.find((n) => n.phoneNumberId === phoneNumberId);
      const staggerDelaySecs = numberIndex * STAGGER_MINUTES * 60;
      const numberExtras: { wabaid?: string; apiKey?: string; source?: string; endpoint?: string } =
        bizNumbersById.get(phoneNumberId) || {};
      for (let i = 0; i < numberContacts.length; i += BATCH_SIZE) {
        batches.push({
          contacts: numberContacts.slice(i, i + BATCH_SIZE),
          phoneNumberId,
          displayName: number?.displayName || "",
          wabaid: numberExtras?.wabaid,
          apiKey: numberExtras?.apiKey,
          source: numberExtras?.source,
          endpoint: numberExtras?.endpoint,
          delaySeconds: staggerDelaySecs,
        });
      }
    }

    console.log(`Created ${batches.length} batches across ${numberCount} numbers (stagger: ${STAGGER_MINUTES}min between numbers)`);

    // Push batches to SQS (max 10 per SendMessageBatch)
    // Each number's batches get a DelaySeconds so numbers start staggered,
    // not all simultaneously. Number 0 starts immediately, number 1 starts
    // after STAGGER_MINUTES, number 2 after 2×STAGGER_MINUTES, etc.
    // SQS max delay is 900 seconds (15 min) — enough for 15+ numbers at 1min stagger.
    for (let i = 0; i < batches.length; i += 10) {
      const chunk = batches.slice(i, i + 10);
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: QUEUE_URL,
          Entries: chunk.map((batch, idx) => ({
            Id: `${i + idx}`,
            DelaySeconds: Math.min(batch.delaySeconds || 0, 900),
            MessageBody: JSON.stringify({
              campaignId,
              provider,
              templateName: campaign.templateName,
              templateMappings: campaign.templateMappings,
              parameterMapping: campaign.parameterMapping,
              headerImageUrl: (campaign as unknown as { headerImageUrl?: string }).headerImageUrl,
              numbersWithImageHeader: (campaign as unknown as { numbersWithImageHeader?: string[] }).numbersWithImageHeader,
              accessToken,
              batch,
            }),
          })),
        })
      );
    }

    console.log(`Queued ${batches.length} batches to SQS`);
    return { batches: batches.length, contacts: contacts.length };
  } catch (err) {
    console.error("Orchestrator error:", err);
    return { error: "Orchestrator failed" };
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
    new GetObjectCommand({ Bucket: process.env.CSV_BUCKET!, Key: s3Key })
  );
  const csvText = await result.Body!.transformToString();
  const lines = csvText.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    const contact: CSVContact = { phone: "" };
    headers.forEach((header, i) => { contact[header] = values[i]; });
    contact.phone = contact.phone || "";
    return contact;
  });
}
