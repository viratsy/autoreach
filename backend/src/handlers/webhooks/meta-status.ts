import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error } from "../../lib/response";

/**
 * Handles Meta WhatsApp webhook status updates.
 * Meta sends: sent, delivered, read, failed status callbacks.
 * Uses GSI1 on Messages table to find message by Meta message ID.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  // Webhook verification (GET request from Meta)
  if (event.httpMethod === "GET") {
    const mode = event.queryStringParameters?.["hub.mode"];
    const token = event.queryStringParameters?.["hub.verify_token"];
    const challenge = event.queryStringParameters?.["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge || "" };
    }
    return error(403, "Verification failed");
  }

  // Process status updates (POST from Meta)
  try {
    const body = JSON.parse(event.body || "{}");
    console.log("Webhook received:", JSON.stringify(body));
    const entries = body.entry || [];

    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const statuses = change.value?.statuses || [];

        for (const status of statuses) {
          await processStatusUpdate(status);
        }
      }
    }

    return success({ status: "ok" });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return success({ status: "ok" }); // Always return 200 to Meta
  }
};

async function processStatusUpdate(status: {
  id: string;
  status: string;
  timestamp: string;
  errors?: { code: number; title: string }[];
}) {
  const metaMessageId = status.id;
  const newStatus = status.status; // sent, delivered, read, failed

  // Find message by Meta message ID using GSI1
  const queryResult = await docClient.send(
    new QueryCommand({
      TableName: TABLES.MESSAGES,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `METAMSG#${metaMessageId}` },
    })
  );

  const message = queryResult.Items?.[0];
  if (!message) return; // Unknown message, skip

  // Update message status (only advance forward, never go backward)
  const statusOrder = ["queued", "sent", "delivered", "read"];
  const currentIndex = statusOrder.indexOf(message.status);
  const newIndex = statusOrder.indexOf(newStatus);

  // Allow update if new status is ahead, or if it's "failed"
  if (newStatus === "failed" || newIndex > currentIndex) {
    const updateExpr = newStatus === "failed"
      ? "SET #status = :status, errorCode = :errorCode, updatedAt = :now"
      : "SET #status = :status, updatedAt = :now";

    const exprValues: Record<string, unknown> = {
      ":status": newStatus,
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
  }
}
