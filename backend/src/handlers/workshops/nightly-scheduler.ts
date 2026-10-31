import { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { getAvailableNumbers, filterNumbersWithImageHeader, deriveTimeLabels, buildContactParams } from "../../lib/reengagement-contacts";
import { chunkForSQSBatch } from "../../lib/sqs-batching";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

const REENGAGEMENT_TABLE = process.env.REENGAGEMENT_TABLE!;
const MASTERCLASS_TABLE = process.env.MASTERCLASS_TABLE || "masterclass_lookup_key";
const WORKSHOP_DB_TABLE = process.env.WORKSHOP_DB_TABLE || "WhatsAppDatabase";
const MENTOR_NAME = process.env.MENTOR_NAME || "Hardik Raja";
const SEND_QUEUE_URL = process.env.SEND_QUEUE_URL!;

/**
 * Nightly scheduler - runs at 1 AM IST daily.
 * 1. Move "waiting" contacts to "active" if their first batch is over
 * 2. For "active" contacts: check payment, schedule campaigns
 */
export const handler: Handler = async () => {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  console.log(`Nightly scheduler running. Today: ${today}`);

  // Step 1: Move "waiting" → "active" for contacts whose first batch is over
  await activateWaitingContacts(today);

  // Step 2: Process "active" contacts
  await processActiveContacts(today);

  console.log("Nightly scheduler complete");
};

async function activateWaitingContacts(today: string) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: REENGAGEMENT_TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": "STATUS#waiting" },
    })
  );

  const waiting = result.Items || [];
  let activated = 0;

  for (const item of waiting) {
    // If first batch date has passed, activate
    if (item.firstBatchDate && item.firstBatchDate < today) {
      await docClient.send(
        new UpdateCommand({
          TableName: REENGAGEMENT_TABLE,
          Key: { PK: item.PK, SK: item.SK },
          UpdateExpression: "SET #status = :status, GSI1PK = :gsi1pk, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "active",
            ":gsi1pk": "STATUS#active",
            ":now": new Date().toISOString(),
          },
        })
      );
      activated++;
    }
  }

  console.log(`Activated ${activated} contacts from waiting → active`);
}

async function processActiveContacts(today: string) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: REENGAGEMENT_TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": "STATUS#active" },
    })
  );

  const active = result.Items || [];
  console.log(`Processing ${active.length} active contacts`);

  // Group by workshop
  const byWorkshop: Record<string, typeof active> = {};
  for (const item of active) {
    if (!byWorkshop[item.wsCode]) byWorkshop[item.wsCode] = [];
    byWorkshop[item.wsCode].push(item);
  }

  for (const [wsCode, contacts] of Object.entries(byWorkshop)) {
    // Get current batch details from WhatsAppDatabase
    const workshopName = contacts[0].workshopName;
    const batchDetails = await getWorkshopBatchDetails(workshopName);

    if (!batchDetails) {
      console.log(`No batch details found for ${workshopName}, skipping`);
      continue;
    }

    console.log(`Workshop: ${workshopName}, batch date: ${batchDetails.date}, contacts: ${contacts.length}`);

    // Filter: check payment status for each contact
    const eligible: typeof contacts = [];

    for (const contact of contacts) {
      const isPaid = await checkMasterclass(contact.phone, contact.email);
      if (isPaid) {
        // Mark as converted, set TTL
        const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days
        await docClient.send(
          new UpdateCommand({
            TableName: REENGAGEMENT_TABLE,
            Key: { PK: contact.PK, SK: contact.SK },
            UpdateExpression: "SET #status = :status, GSI1PK = :gsi1pk, #ttl = :ttl, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status", "#ttl": "ttl" },
            ExpressionAttributeValues: {
              ":status": "converted",
              ":gsi1pk": "STATUS#converted",
              ":ttl": ttl,
              ":now": new Date().toISOString(),
            },
          })
        );
        console.log(`Contact ${contact.phone} converted (paid)`);
      } else {
        eligible.push(contact);
      }
    }

    if (eligible.length === 0) {
      console.log(`No eligible contacts for ${workshopName}`);
      continue;
    }

    console.log(`${eligible.length} eligible contacts for ${workshopName} re-engagement`);

    // Group contacts by counter to handle different cycles
    const byCounter: Record<number, typeof eligible> = {};
    for (const contact of eligible) {
      const c = contact.counter;
      if (!byCounter[c]) byCounter[c] = [];
      byCounter[c].push(contact);
    }

    for (const [counterStr, counterContacts] of Object.entries(byCounter)) {
    const counter = Number(counterStr);
    // counter=0 → Cycle 0 (current batch), counter=1 → Cycle 1, etc.
    const cycle = counter;
    const configResult = await docClient.send(
      new GetCommand({
        TableName: process.env.WORKSHOP_CONFIG_TABLE || "autoreach-workshop-config-hardik",
        Key: { PK: `WSCONFIG#${wsCode}`, SK: `CYCLE#${cycle > 4 ? 4 : cycle}` },
      })
    );
    const wsConfig = configResult.Item;

    if (!wsConfig || !wsConfig.runKeys || Object.keys(wsConfig.runKeys).length === 0) {
      console.log(`No config found for ${wsCode} cycle ${cycle}, skipping campaign creation`);
    } else {
      // Get business access token
      const bizResult = await docClient.send(
        new GetCommand({
          TableName: process.env.BUSINESSES_TABLE || "autoreach-businesses",
          Key: { PK: `BIZ#${wsConfig.businessId}`, SK: "METADATA" },
        })
      );
      const business = bizResult.Item;
      const accessToken = business?.accessToken || "";

      if (accessToken) {
        // Schedule campaigns per run_key
        const { SQSClient, SendMessageBatchCommand } = await import("@aws-sdk/client-sqs");
        const sqs = new SQSClient({});

        // Sending pool for this workshop — one shared template+params per run
        // key now (not per number, see workshop config redesign), so the
        // per-number nuance that actually matters is just "does this number
        // have that template approved yet", checked against the templates
        // table exactly like campaign creation's SelectTemplate does.
        const sendingPool = Object.keys(wsConfig.numbers || {});

        for (const [runKey, runKeyConfig] of Object.entries(wsConfig.runKeys as Record<string, { templateName: string; bodyParams: string[]; headerImageUrl?: string }>)) {
          if (!runKeyConfig?.templateName || sendingPool.length === 0) continue;

          const numbers = await getAvailableNumbers(wsConfig.businessId as string, sendingPool, runKeyConfig.templateName);
          if (numbers.length === 0) {
            console.log(`No numbers have template ${runKeyConfig.templateName} approved for run key ${runKey}, skipping`);
            continue;
          }

          // See filterNumbersWithImageHeader — a number whose approved copy has
          // no header slot must not be sent a header image, or Meta rejects
          // every message to it.
          const imageHeaderNumbers = runKeyConfig.headerImageUrl
            ? await filterNumbersWithImageHeader(wsConfig.businessId as string, runKeyConfig.templateName, numbers)
            : [];

          // Every run key carries its own bodyParams now — the inherited ones
          // were written onto each config when WSCONFIG#__DEFAULT__ was retired.
          const bodyParams = runKeyConfig.bodyParams || [];

          // Build contacts with resolved params
          const contactBatches: { contacts: Record<string, string>[]; phoneNumberId: string }[] = [];

          // Distribute contacts round-robin across the available numbers
          const perNumber: Record<string, typeof counterContacts> = {};
          counterContacts.forEach((contact, i) => {
            const numId = numbers[i % numbers.length];
            if (!perNumber[numId]) perNumber[numId] = [];
            perNumber[numId].push(contact);
          });

          for (const [numId, numContacts] of Object.entries(perNumber)) {
            const wsDate = batchDetails.Date || "";
            const labels = deriveTimeLabels(wsDate);
            contactBatches.push({
              contacts: numContacts.map((c) =>
                buildContactParams(
                  { phone: c.phone, name: c.name, email: c.email },
                  workshopName,
                  wsDate,
                  labels,
                  batchDetails.ZoomLink || "",
                  batchDetails.WhatsappLink || "",
                  MENTOR_NAME
                )
              ),
              phoneNumberId: numId,
            });
          }

          // Push to SQS for sending. Chunked via chunkForSQSBatch, not just
          // by count of 10 — a SendMessageBatch call also caps out at
          // 1,048,576 total bytes, which count-only chunking can silently
          // exceed once contact batches carry enough per-contact params
          // (confirmed in production on the equivalent path in send.ts).
          const sqsEntries = contactBatches.map((batch, idx) => ({
            Id: `ws-${wsCode}-${runKey}-${idx}`,
            MessageBody: JSON.stringify({
              campaignId: `ws_${wsCode}_${today}_${runKey}`,
              templateName: runKeyConfig.templateName,
              templateMappings: {},
              parameterMapping: Object.fromEntries(bodyParams.map((p, pi) => [String(pi + 1), p.startsWith("__CUSTOM__") ? `__STATIC__${wsConfig.customParams?.[p.replace("__CUSTOM__", "")] || ""}` : p])),
              headerImageUrl: runKeyConfig.headerImageUrl || "",
              numbersWithImageHeader: imageHeaderNumbers.includes(batch.phoneNumberId) ? [batch.phoneNumberId] : [],
              accessToken,
              batch: {
                contacts: batch.contacts,
                phoneNumberId: batch.phoneNumberId,
                displayName: wsConfig.numbers?.[batch.phoneNumberId]?.displayName || "",
              },
            }),
          }));
          for (const chunk of chunkForSQSBatch(sqsEntries, (e) => Buffer.byteLength(e.MessageBody, "utf8"))) {
            await sqs.send(new SendMessageBatchCommand({ QueueUrl: SEND_QUEUE_URL, Entries: chunk }));
          }

          console.log(`Queued ${runKey} for ${counterContacts.length} contacts across ${numbers.length}/${sendingPool.length} numbers (template: ${runKeyConfig.templateName})`);
        }
      }
    }

    // Increment counters for this batch of contacts
    for (const contact of counterContacts) {
      const newCounter = (contact.counter || 0) + 1;
      const isCompleted = newCounter >= 4;
      const ttl = isCompleted ? Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 : undefined;

      await docClient.send(
        new UpdateCommand({
          TableName: REENGAGEMENT_TABLE,
          Key: { PK: contact.PK, SK: contact.SK },
          UpdateExpression: `SET #counter = :counter, lastBatchDate = :batchDate, #status = :status, GSI1PK = :gsi1pk, updatedAt = :now${ttl ? ", #ttl = :ttl" : ""}`,
          ExpressionAttributeNames: {
            "#counter": "counter",
            "#status": "status",
            ...(ttl ? { "#ttl": "ttl" } : {}),
          },
          ExpressionAttributeValues: {
            ":counter": newCounter,
            ":batchDate": today,
            ":status": isCompleted ? "completed" : "active",
            ":gsi1pk": isCompleted ? "STATUS#completed" : "STATUS#active",
            ":now": new Date().toISOString(),
            ...(ttl ? { ":ttl": ttl } : {}),
          },
        })
      );
    }

    console.log(`Incremented counters for ${counterContacts.length} contacts (cycle ${cycle}) in ${workshopName}`);
    } // end for byCounter
  }
}

async function getWorkshopBatchDetails(workshopName: string) {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: WORKSHOP_DB_TABLE,
        Key: { Name: workshopName },
      })
    );
    return result.Item || null;
  } catch {
    return null;
  }
}

async function checkMasterclass(phone: string, email: string): Promise<boolean> {
  // The table's actual partition key attribute is "pk" (confirmed against real
  // rows: {pk: "PHONE#91...", type: "phone", ...} / {pk: "EMAIL#...", type: "email", ...}) —
  // NOT "masterclass_lookup_key". A GetItem keyed on the wrong attribute name
  // throws ValidationException, which the empty catch below swallows, so this
  // previously returned "not paid" unconditionally for every single call.
  try {
    const phoneResult = await docClient.send(
      new GetCommand({
        TableName: MASTERCLASS_TABLE,
        Key: { pk: `PHONE#${phone}` },
      })
    );
    if (phoneResult.Item) return true;
  } catch {}

  // Check by email
  if (email) {
    try {
      const emailResult = await docClient.send(
        new GetCommand({
          TableName: MASTERCLASS_TABLE,
          Key: { pk: `EMAIL#${email}` },
        })
      );
      if (emailResult.Item) return true;
    } catch {}
  }

  return false;
}

