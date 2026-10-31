import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { extractKnownErrorCode, META_ERROR_CODES } from "../../lib/error-codes";

/**
 * Polls delivery status for messages sent via test-send.ts. Meta's initial send
 * response only confirms the message was accepted, not delivered — a payment/
 * billing issue or similar often only shows up a few seconds later via the async
 * status webhook, which test-send.ts now tracks a record for (GSI1PK lookup,
 * same convention webhook-worker.ts already uses for real campaign messages).
 * GET /campaigns/test-send/status?messageIds=id1,id2
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const messageIds = (event.queryStringParameters?.messageIds || "").split(",").filter(Boolean);
    if (messageIds.length === 0) return error(400, "messageIds is required", origin);

    const statuses: Record<string, { status: string; errorCode?: string; errorLabel?: string }> = {};

    for (const messageId of messageIds) {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLES.MESSAGES,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": `METAMSG#${messageId}` },
        })
      );
      const item = result.Items?.[0];
      if (!item) {
        statuses[messageId] = { status: "unknown" };
        continue;
      }

      const errorCode = item.errorCode as string | null | undefined;
      const knownCode = errorCode ? extractKnownErrorCode(errorCode) : null;
      statuses[messageId] = {
        status: item.status as string,
        errorCode: errorCode || undefined,
        errorLabel: knownCode ? META_ERROR_CODES[knownCode].label : undefined,
      };
    }

    return success({ statuses }, origin);
  } catch (err) {
    console.error("Test-send status error:", err);
    return error(500, "Failed to check status", origin);
  }
};
