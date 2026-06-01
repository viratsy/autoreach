import { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

const REENGAGEMENT_TABLE = process.env.REENGAGEMENT_TABLE!;
const MASTERCLASS_TABLE = process.env.MASTERCLASS_TABLE || "masterclass_lookup_key";
const WORKSHOP_DB_TABLE = process.env.WORKSHOP_DB_TABLE || "WhatsAppDatabase";
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

    // Get workshop config for this cycle
    const cycle = eligible[0].counter + 1; // next cycle
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

        for (const [runKey, runKeyConfig] of Object.entries(wsConfig.runKeys as Record<string, { numbers: Record<string, { templateName: string; bodyParams: string[] }> }>)) {
          const numbers = Object.keys(runKeyConfig.numbers || {});
          if (numbers.length === 0) continue;

          // Build contacts with resolved params
          const contactBatches: { contacts: { phone: string; name: string; [key: string]: string }[]; phoneNumberId: string; templateName: string; bodyParams: string[] }[] = [];

          // Distribute contacts round-robin across numbers
          const perNumber: Record<string, typeof eligible> = {};
          eligible.forEach((contact, i) => {
            const numId = numbers[i % numbers.length];
            if (!perNumber[numId]) perNumber[numId] = [];
            perNumber[numId].push(contact);
          });

          for (const [numId, numContacts] of Object.entries(perNumber)) {
            const numConfig = runKeyConfig.numbers[numId];
            if (!numConfig?.templateName) continue;

            contactBatches.push({
              contacts: numContacts.map((c) => ({
                phone: c.phone,
                name: c.name,
                email: c.email,
                workshop_name: workshopName,
                workshop_date: batchDetails.Date || "",
                workshop_time: batchDetails.Date?.includes("07:00") ? "07:00 PM IST" : "11:00 AM IST",
                zoom_link: batchDetails.ZoomLink || "",
                whatsapp_group: batchDetails.WhatsappLink || "",
              })),
              phoneNumberId: numId,
              templateName: numConfig.templateName,
              bodyParams: numConfig.bodyParams || [],
            });
          }

          // Push to SQS for sending
          for (let i = 0; i < contactBatches.length; i += 10) {
            const chunk = contactBatches.slice(i, i + 10);
            await sqs.send(
              new SendMessageBatchCommand({
                QueueUrl: SEND_QUEUE_URL,
                Entries: chunk.map((batch, idx) => ({
                  Id: `ws-${wsCode}-${runKey}-${i + idx}`,
                  MessageBody: JSON.stringify({
                    campaignId: `ws_${wsCode}_${today}_${runKey}`,
                    templateName: batch.templateName,
                    templateMappings: {},
                    parameterMapping: Object.fromEntries(batch.bodyParams.map((p, pi) => [String(pi + 1), p.startsWith("__CUSTOM__") ? `__STATIC__${wsConfig.customParams?.[p.replace("__CUSTOM__", "")] || ""}` : p])),
                    headerImageUrl: "",
                    numbersWithImageHeader: [],
                    accessToken,
                    batch: {
                      contacts: batch.contacts,
                      phoneNumberId: batch.phoneNumberId,
                      displayName: wsConfig.numbers?.[batch.phoneNumberId]?.displayName || "",
                    },
                  }),
                })),
              })
            );
          }

          console.log(`Queued ${runKey} for ${eligible.length} contacts across ${numbers.length} numbers`);
        }
      }
    }

    for (const contact of eligible) {
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

    console.log(`Incremented counters for ${eligible.length} contacts in ${workshopName}`);
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
  // Check by phone
  try {
    const phoneResult = await docClient.send(
      new GetCommand({
        TableName: MASTERCLASS_TABLE,
        Key: { masterclass_lookup_key: `PHONE#${phone}` },
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
          Key: { masterclass_lookup_key: `EMAIL#${email}` },
        })
      );
      if (emailResult.Item) return true;
    } catch {}
  }

  return false;
}
