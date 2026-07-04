import { SQSHandler } from "aws-lambda";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { createNotification } from "../notifications/index";

const UNSUBSCRIBE_TABLE = process.env.UNSUBSCRIBE_TABLE || `autoreach-unsubscribe-${process.env.ENV_NAME || "hardik"}`;
const UNSUBSCRIBE_KEYWORDS = ["stop", "unsubscribe", "opt out", "optout", "cancel", "remove me", "don't send", "dont send"];

/**
 * Async webhook processor — reads from SQS, handles status updates and incoming messages.
 * Processes in batches for throughput.
 */
export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body);
      // Log raw payload so we can see exactly what Meta sends
      console.log("WEBHOOK_PAYLOAD:", JSON.stringify(body));
      const entries = body.entry || [];

      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          // Handle message status updates
          const statuses = change.value?.statuses || [];
          for (const status of statuses) {
            await processStatusUpdate(status);
          }

          // Handle incoming messages
          const messages = change.value?.messages || [];
          const metadata = change.value?.metadata;
          for (const msg of messages) {
            let messageText = "";
            if (msg.type === "text" && msg.text?.body) {
              messageText = msg.text.body;
            } else if (msg.type === "interactive") {
              messageText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
            } else if (msg.type === "button") {
              messageText = msg.button?.text || "";
            }

            if (messageText) {
              await checkUnsubscribe(msg.from, messageText);
              // Track reply on campaign messages
              await trackCampaignReply(msg.from);
              try {
                await triggerFlowEngine({ ...msg, text: { body: messageText } }, metadata);
              } catch (flowErr) {
                console.error("Flow engine error (non-fatal):", flowErr);
              }
            }
          }

          // Handle template category updates
          if (change.field === "template_category_update") {
            await processTemplateCategoryUpdate(change.value, entry.id);
          }
        }
      }
    } catch (err) {
      console.error("Webhook worker error:", err);
      // Don't throw — let the message be deleted from queue
    }
  }
};

async function processStatusUpdate(status: {
  id: string;
  status: string;
  timestamp: string;
  errors?: { code: number; title: string }[];
}) {
  const metaMessageId = status.id;
  const newStatus = status.status;
  console.log(`STATUS_UPDATE: msgId=${metaMessageId} status=${newStatus}`);

  const queryResult = await docClient.send(
    new QueryCommand({
      TableName: TABLES.MESSAGES,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `METAMSG#${metaMessageId}` },
    })
  );

  const message = queryResult.Items?.[0];
  if (!message) return;

  const statusOrder = ["queued", "sent", "delivered", "read"];
  const currentIndex = statusOrder.indexOf(message.status);
  const newIndex = statusOrder.indexOf(newStatus);

  if (newStatus === "failed" || newIndex > currentIndex) {
    const updateExpr = newStatus === "failed"
      ? "SET #status = :status, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk, errorCode = :errorCode, updatedAt = :now"
      : "SET #status = :status, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk, updatedAt = :now";

    const exprValues: Record<string, unknown> = {
      ":status": newStatus,
      ":gsi3pk": `${message.PK}#STATUS#${newStatus}`,
      ":gsi3sk": message.SK,
      ":now": new Date().toISOString(),
    };

    if (newStatus === "failed" && status.errors?.[0]) {
      exprValues[":errorCode"] = String(status.errors[0].code);
    }

    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.MESSAGES,
        Key: { PK: message.PK, SK: message.SK },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: exprValues,
      })
    );

    // Update counts on campaign record (best-effort, non-critical)
    const campaignId = (message.PK as string).replace("CAMP#", "");
    try {
      if (newStatus === "delivered") {
        await docClient.send(new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "SET updatedAt = :now ADD deliveredCount :one",
          ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
        }));
      } else if (newStatus === "read") {
        await docClient.send(new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "SET updatedAt = :now ADD readCount :one",
          ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
        }));
      } else if (newStatus === "failed") {
        await docClient.send(new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "SET updatedAt = :now ADD failedCount :one",
          ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
        }));
      }
    } catch { /* non-critical */ }
  }
}

async function processTemplateCategoryUpdate(value: {
  message_template_name?: string;
  new_category?: string;
}, wabaid: string) {
  const templateName = value.message_template_name;
  const newCategory = value.new_category;
  if (!templateName || !newCategory) return;
  console.log(`Template category update: ${templateName} → ${newCategory} (WABA: ${wabaid})`);
}

async function checkUnsubscribe(from: string, text: string) {
  const lower = text.toLowerCase().trim();
  const isUnsubscribe = UNSUBSCRIBE_KEYWORDS.some((kw) => lower.includes(kw));
  if (!isUnsubscribe) return;

  const phone = from.replace(/\D/g, "");
  console.log(`Unsubscribe detected from ${phone}: "${text}"`);

  try {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await docClient.send(
      new PutCommand({
        TableName: UNSUBSCRIBE_TABLE,
        Item: {
          PK: `PHONE#${phone}`,
          phone,
          reason: text,
          unsubscribedAt: new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    console.error("Failed to save unsubscribe:", err);
  }
}

async function triggerFlowEngine(
  msg: { from: string; text?: { body: string }; id?: string },
  metadata?: { phone_number_id?: string; display_phone_number?: string }
) {
  try {
    const { handleIncomingMessage } = await import("../flows/execute");
    const phone = msg.from.replace(/\D/g, "");
    const phoneNumberId = metadata?.phone_number_id || "";

    // Find businessId from phoneNumberId
    const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
    let businessId = "";
    const allBiz = await docClient.send(new ScanCommand({ TableName: TABLES.BUSINESSES }));
    for (const biz of allBiz.Items || []) {
      const numbers = biz.phoneNumbers || [];
      if (numbers.some((n: any) => n.phoneNumberId === phoneNumberId)) {
        businessId = biz.businessId || "";
        break;
      }
    }

    if (!businessId) {
      console.log(`Flow engine: No business found for phoneNumberId ${phoneNumberId}`);
      return;
    }

    await handleIncomingMessage({
      phone,
      phoneNumberId,
      text: msg.text?.body || "",
      contactName: "",
      metaMessageId: msg.id || "",
      businessId,
    });
  } catch (err) {
    console.error("Flow engine trigger error:", err);
  }
}

/**
 * Track campaign reply — when someone replies, find their most recent campaign message
 * and update repliedAt timestamp.
 */
async function trackCampaignReply(from: string) {
  const phone = from.replace(/\D/g, "");

  try {
    // We know SK = MSG#<phone> but don't know which campaign (PK).
    // Use a Scan with a filter on SK directly — DynamoDB can filter on sort key
    // even during scan. Remove Limit so it actually finds the record.
    const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLES.MESSAGES,
        FilterExpression: "SK = :sk AND (attribute_not_exists(repliedAt) OR repliedAt = :null)",
        ExpressionAttributeValues: {
          ":sk": `MSG#${phone}`,
          ":null": null,
        },
        ProjectionExpression: "PK, SK, sentAt",
      })
    );

    if (!result.Items?.length) return;

    // Update the most recent one (sort by sentAt desc)
    const sorted = result.Items.sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || ""));
    const latest = sorted[0];

    if (latest) {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.MESSAGES,
          Key: { PK: latest.PK, SK: latest.SK },
          UpdateExpression: "SET repliedAt = :now",
          ExpressionAttributeValues: { ":now": new Date().toISOString() },
        })
      );
      console.log(`Reply tracked: ${phone} → ${latest.PK}`);
    }
  } catch (err) {
    // Non-critical — don't fail the webhook processing
    console.error("Reply tracking error:", err);
  }
}
