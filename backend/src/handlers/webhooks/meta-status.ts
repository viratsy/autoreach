import { APIGatewayProxyHandler } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createHmac, timingSafeEqual } from "crypto";
import { success, error } from "../../lib/response";

const sqs = new SQSClient({});
const WEBHOOK_QUEUE_URL = process.env.WEBHOOK_QUEUE_URL || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

/**
 * Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body, keyed
 * by the app secret). Deliberately fail-open: META_APP_SECRET is blank until the
 * team provisions each stack's real Meta App Secret, so until then this only logs
 * a warning rather than rejecting webhook traffic that's working today.
 */
function isValidSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!META_APP_SECRET) {
    console.warn("META_APP_SECRET not configured — skipping webhook signature verification");
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", META_APP_SECRET).update(rawBody, "utf8").digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

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
    const signatureHeader = event.headers?.["X-Hub-Signature-256"] || event.headers?.["x-hub-signature-256"];

    if (!isValidSignature(body, signatureHeader)) {
      console.error("Webhook signature verification failed");
      return error(401, "Invalid signature");
    }

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
