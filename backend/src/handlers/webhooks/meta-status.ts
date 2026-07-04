import { APIGatewayProxyHandler } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { success, error } from "../../lib/response";

const sqs = new SQSClient({});
const WEBHOOK_QUEUE_URL = process.env.WEBHOOK_QUEUE_URL || "";

/**
 * Meta WhatsApp webhook — now INSTANT response.
 * Receives status updates + incoming messages, pushes to SQS for async processing.
 * This ensures Meta never gets a timeout and doesn't retry.
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

  // POST — push to SQS immediately, return 200 to Meta
  try {
    const body = event.body || "{}";
    console.log("Webhook received, pushing to queue");

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: WEBHOOK_QUEUE_URL,
        MessageBody: body,
      })
    );

    return success({ status: "ok" });
  } catch (err) {
    console.error("Failed to queue webhook:", err);
    // Still return 200 to Meta to prevent retries
    return success({ status: "ok" });
  }
};
