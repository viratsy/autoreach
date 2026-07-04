import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const sqs = new SQSClient({});
const SEND_QUEUE_URL = process.env.SEND_QUEUE_URL || "";

// Errors that are NOT retryable (contact/number issues, not our fault)
const NON_RETRYABLE_ERRORS = [
  "not a valid whatsapp",
  "recipient is not a valid",
  "incapable of receiving",
  "number does not exist",
  "invalid recipient",
  "not registered",
  "deregistered",
  "unavailable",
  "blocked",
  "spam",
];

// Errors that ARE retryable (our issue or transient)
const RETRYABLE_ERRORS = [
  "rate limit",
  "template",
  "param",
  "payment",
  "insufficient",
  "timeout",
  "internal",
  "temporarily",
  "try again",
];

/**
 * Retry failed messages for a campaign.
 * Only retries messages that failed due to retryable errors (template, payment, rate limit).
 * Non-retryable errors (invalid number, blocked) are skipped.
 * 
 * POST /campaigns/{campaignId}/retry
 * Also invoked asynchronously by SendWorkerFunction.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId required", origin);

    // Get campaign details
    const campResult = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = campResult.Item;
    if (!campaign) return error(404, "Campaign not found", origin);

    // Get all failed messages
    const failedResult = await docClient.send(
      new QueryCommand({
        TableName: TABLES.MESSAGES,
        KeyConditionExpression: "PK = :pk",
        FilterExpression: "#s = :failed",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":failed": "failed" },
      })
    );

    const failedMessages = failedResult.Items || [];
    console.log(`Retry: ${failedMessages.length} failed messages for campaign ${campaignId}`);

    if (failedMessages.length === 0) {
      // No failures — mark as completed
      await markCompleted(campaignId);
      return success({ message: "No failed messages, campaign completed", retried: 0 }, origin);
    }

    // Separate retryable vs non-retryable
    const retryable: typeof failedMessages = [];
    const nonRetryable: typeof failedMessages = [];

    for (const msg of failedMessages) {
      const errCode = (msg.errorCode || "").toLowerCase();
      
      if (isNonRetryable(errCode)) {
        nonRetryable.push(msg);
      } else if (isRetryable(errCode)) {
        retryable.push(msg);
      } else {
        // Unknown error — don't retry, just skip
        nonRetryable.push(msg);
      }
    }

    console.log(`Retry: ${retryable.length} retryable, ${nonRetryable.length} non-retryable`);

    if (retryable.length === 0) {
      // Nothing to retry — mark completed
      await markCompleted(campaignId);
      return success({ message: "No retryable failures, campaign completed", retried: 0, skipped: nonRetryable.length }, origin);
    }

    // Get business for access token
    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${campaign.businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) {
      await markCompleted(campaignId);
      return error(500, "Business not found for retry", origin);
    }

    const accessToken = business.accessToken;

    // Group retryable messages by sending number
    const byNumber: Record<string, typeof retryable> = {};
    for (const msg of retryable) {
      const numId = msg.sendingNumberId;
      if (!byNumber[numId]) byNumber[numId] = [];
      byNumber[numId].push(msg);
    }

    // Queue retry batches
    for (const [phoneNumberId, messages] of Object.entries(byNumber)) {
      const contacts = messages.map((m) => ({
        phone: m.phoneNumber,
        name: m.contactName || "",
      }));

      // Delete old failed records so they can be re-created
      for (const msg of messages) {
        await docClient.send(
          new UpdateCommand({
            TableName: TABLES.MESSAGES,
            Key: { PK: msg.PK, SK: msg.SK },
            UpdateExpression: "SET #s = :s, errorCode = :null, updatedAt = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":s": "queued", ":null": null, ":now": new Date().toISOString() },
          })
        );
      }

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: SEND_QUEUE_URL,
          MessageBody: JSON.stringify({
            campaignId,
            templateName: campaign.templateName,
            templateMappings: campaign.templateMappings || {},
            parameterMapping: campaign.parameterMapping || {},
            headerImageUrl: campaign.headerImageUrl || "",
            numbersWithImageHeader: campaign.numbersWithImageHeader || [],
            accessToken,
            batch: {
              contacts,
              phoneNumberId,
              displayName: "",
            },
          }),
        })
      );
    }

    console.log(`Retry: Queued ${retryable.length} messages for retry`);
    return success({ message: "Retry queued", retried: retryable.length, skipped: nonRetryable.length }, origin);
  } catch (err) {
    console.error("Retry failed error:", err);
    // Still mark as completed so it doesn't stay running forever
    const campaignId = event.pathParameters?.campaignId;
    if (campaignId) await markCompleted(campaignId);
    return error(500, "Retry failed", origin);
  }
};

function isNonRetryable(errCode: string): boolean {
  return NON_RETRYABLE_ERRORS.some((e) => errCode.includes(e));
}

function isRetryable(errCode: string): boolean {
  return RETRYABLE_ERRORS.some((e) => errCode.includes(e));
}

async function markCompleted(campaignId: string) {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.CAMPAIGNS,
      Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
      UpdateExpression: "SET #status = :s, GSI2PK = :gsi, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": "completed",
        ":gsi": "STATUS#completed",
        ":now": new Date().toISOString(),
      },
    })
  );
  console.log(`Campaign ${campaignId} marked as completed`);
}
