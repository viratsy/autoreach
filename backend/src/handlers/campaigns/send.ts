import { Handler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { docClient, TABLES } from "../../lib/dynamo";
import { CSVContact, CampaignRecord, PhoneNumber as PhoneNumberRecord } from "../../lib/types";
import { parseCSVWithHeaders } from "../../lib/csv";
import { filterHealthyNumbers, distributeContactsWeighted } from "../../lib/round-robin";
import { chunkForSQSBatch } from "../../lib/sqs-batching";
import { createNotification } from "../notifications/index";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const QUEUE_URL = process.env.SEND_QUEUE_URL!;
const EMAIL_QUEUE_URL = process.env.EMAIL_QUEUE_URL || "";
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
      ((business?.phoneNumbers || []) as PhoneNumberRecord[])
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
            `https://graph.facebook.com/v25.0/${wabaid}/message_templates?name=${encodeURIComponent(campaign.templateName)}&limit=25`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const tplData = (await tplRes.json()) as { data?: { name: string; category: string }[] };
          // ?name= is a PREFIX match on Meta's side, so data[0] can be a
          // different template that merely starts with this name — match the
          // exact name or this safety check guards the wrong thing.
          const tplMatch = (tplData.data || []).find((t) => t.name === campaign.templateName);
          if (tplMatch?.category === "MARKETING") {
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
      // Surface this in-app (previously only a CloudWatch log) — contacts originally
      // bound for these numbers get rerouted to the rest, not dropped, but the
      // operator should still know a number got excluded and why.
      for (const phoneNumberId of marketingNumbers) {
        const num = campaign.selectedNumbers.find((n) => n.phoneNumberId === phoneNumberId);
        await createNotification({
          type: "template_marketing",
          businessId: campaign.businessId,
          businessName: campaign.businessName,
          phoneNumberId,
          phoneDisplayName: num?.displayName || phoneNumberId,
          templateName: campaign.templateName,
          errorMessage: `Template "${campaign.templateName}" is MARKETING category on this number — excluded from sending, contacts rerouted to the campaign's other ${healthyNumbers.length} number(s).`,
          campaignId,
        });
      }
    }

    // Merge in cached quality/tier data from the business record (campaign.selectedNumbers
    // is a snapshot from creation time and doesn't carry it) so RED-quality numbers can be
    // excluded and remaining numbers weighted by their real 24h messaging tier.
    const withQuality = healthyNumbers.map((n) => ({
      ...n,
      qualityRating: bizNumbersById.get(n.phoneNumberId)?.qualityRating,
      messagingLimit: bizNumbersById.get(n.phoneNumberId)?.messagingLimit,
    }));
    const activeNumbers = filterHealthyNumbers(withQuality);

    // Read CSV
    const contacts = await fetchCSVFromS3(campaign.csvS3Key);
    console.log(`Read ${contacts.length} contacts from CSV`);

    // Distribute across healthy numbers, weighted by cached 24h messaging tier
    // (falls back to a plain even split when no number has a cached tier yet).
    const perNumberContacts = distributeContactsWeighted(contacts, activeNumbers);
    const numberCount = activeNumbers.length;
    const batches: {
      contacts: CSVContact[];
      phoneNumberId: string;
      displayName: string;
      wabaid?: string;
      apiKey?: string;
      source?: string;
      endpoint?: string;
    }[] = [];

    // Split each number's contacts into batches of BATCH_SIZE. No stagger between
    // numbers — SendQueue is a FIFO queue with MessageGroupId = phoneNumberId, so
    // every batch for a given number is already guaranteed to process one-at-a-time
    // in order regardless of how many batches it has; the real per-number pace cap
    // (MSGS_PER_SECOND in send-worker.ts) holds true on its own without needing a
    // start-time offset between numbers.
    const numberOrder = Object.keys(perNumberContacts);
    for (const phoneNumberId of numberOrder) {
      const numberContacts = perNumberContacts[phoneNumberId];
      const number = activeNumbers.find((n) => n.phoneNumberId === phoneNumberId);
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
        });
      }
    }

    console.log(`Created ${batches.length} batches across ${numberCount} numbers`);

    // Record the true batch count up front — send-worker.ts uses this (an atomic
    // ADD counter incremented per completed batch) to detect "is this campaign
    // actually done" without racing concurrent invocations against each other.
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
        UpdateExpression: "SET totalBatches = :tb, completedBatches = :zero",
        ExpressionAttributeValues: { ":tb": batches.length, ":zero": 0 },
      })
    );

    // Push batches to SQS. Each entry is tagged with MessageGroupId =
    // phoneNumberId (FIFO serializes strictly within a group) and a unique
    // MessageDeduplicationId (content-based dedup is off on this queue).
    // Chunked via chunkForSQSBatch, which respects SendMessageBatch's byte
    // cap as well as its 10-entry cap — see that module for why count-only
    // chunking isn't safe here.
    const entries = batches.map((batch, idx) => ({
      Id: `${idx}`,
      MessageGroupId: batch.phoneNumberId,
      MessageDeduplicationId: `${campaignId}-${batch.phoneNumberId}-${idx}`,
      MessageBody: JSON.stringify({
        campaignId,
        provider,
        templateName: campaign.templateName,
        templateMappings: campaign.templateMappings,
        parameterMapping: campaign.parameterMapping,
        headerImageUrl: (campaign as unknown as { headerImageUrl?: string }).headerImageUrl,
        numbersWithImageHeader: (campaign as unknown as { numbersWithImageHeader?: string[] }).numbersWithImageHeader,
        respectUnsubscribeList: campaign.respectUnsubscribeList !== false,
        excludePaidUsers: campaign.excludePaidUsers !== false,
        accessToken,
        batch,
      }),
    }));

    const chunks = chunkForSQSBatch(entries, (e) => Buffer.byteLength(e.MessageBody, "utf8"));
    for (const chunk of chunks) {
      await sqs.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: chunk }));
    }

    // Email rides along with the same audience at the same moment. Queued
    // separately (a standard queue, not the FIFO send queue) so a slow or
    // failing SES send can never stall WhatsApp delivery — the two channels
    // succeed or fail independently. email-worker.ts exits quietly if no email
    // template exists for this campaign's run key, so this is a no-op for
    // campaigns that are WhatsApp-only.
    if (EMAIL_QUEUE_URL && (campaign as unknown as { emailEnabled?: boolean }).emailEnabled === true) {
      try {
        const EMAIL_BATCH_SIZE = 100;
        const emailEntries = [];
        for (let i = 0; i < contacts.length; i += EMAIL_BATCH_SIZE) {
          emailEntries.push({
            Id: `${emailEntries.length}`,
            MessageBody: JSON.stringify({
              campaignId,
              runKey: campaign.msg || "",
              emailTemplateId: (campaign as unknown as { emailTemplateId?: string }).emailTemplateId,
              contacts: contacts.slice(i, i + EMAIL_BATCH_SIZE),
            }),
          });
        }
        const emailChunks = chunkForSQSBatch(emailEntries, (e) => Buffer.byteLength(e.MessageBody, "utf8"));
        for (const chunk of emailChunks) {
          await sqs.send(new SendMessageBatchCommand({ QueueUrl: EMAIL_QUEUE_URL, Entries: chunk }));
        }
        console.log(`Queued ${emailEntries.length} email batch(es) for run key "${campaign.msg}"`);
      } catch (err) {
        // Never fail the WhatsApp send because email queueing broke.
        console.error("Email queueing failed (WhatsApp send unaffected):", err);
      }
    }

    console.log(`Queued ${batches.length} batches to SQS in ${chunks.length} SendMessageBatch call(s)`);
    return { batches: batches.length, contacts: contacts.length };
  } catch (err) {
    console.error("Orchestrator error:", err);
    return { error: "Orchestrator failed" };
  }
};

async function updateCampaignStatus(campaignId: string, status: string) {
  const now = new Date().toISOString();
  // send.ts's "running" transition is the one genuine start of a campaign
  // (this handler only ever runs once per campaignId) — stamp startedAt here
  // so "time taken" can be computed later without conflating it with
  // updatedAt, which keeps changing throughout the run.
  const isStarting = status === "running";
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.CAMPAIGNS,
      Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
      UpdateExpression: isStarting
        ? "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now, startedAt = :now"
        : "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": status,
        ":gsi2pk": `STATUS#${status}`,
        ":now": now,
      },
    })
  );
}

async function fetchCSVFromS3(s3Key: string): Promise<CSVContact[]> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: process.env.CSV_BUCKET!, Key: s3Key })
  );
  const csvText = await result.Body!.transformToString();
  const { records } = parseCSVWithHeaders(csvText);

  return records.map((record) => ({ ...record, phone: record.phone || "" } as CSVContact));
}
