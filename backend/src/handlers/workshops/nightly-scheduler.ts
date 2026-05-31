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

    // TODO: Schedule AutoReach campaigns for eligible contacts
    // This will use the same campaign creation flow:
    // - Create campaign with eligible contacts as CSV
    // - Use templates for each run_key (2days_to_go, 1day_to_go, etc.)
    // - Schedule at appropriate times based on batch date
    // For now, just increment counters

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
