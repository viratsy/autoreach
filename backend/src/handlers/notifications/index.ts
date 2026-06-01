import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE || "autoreach-notifications-hardik";

export interface Notification {
  PK: string; // NOTIF#<id>
  SK: string; // TIMESTAMP#<iso>
  id: string;
  type: "template_marketing" | "send_failed" | "quality_issue" | "payment_issue";
  businessId: string;
  businessName: string;
  phoneNumberId: string;
  phoneDisplayName: string;
  templateName?: string;
  errorMessage?: string;
  campaignId?: string;
  appealLink?: string;
  businessManagerLink?: string;
  createdAt: string;
  resolved: boolean;
}

/**
 * GET /notifications - list active notifications
 * DELETE /notifications?id=xxx - dismiss/resolve a notification
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  if (event.httpMethod === "GET") {
    try {
      const result = await docClient.send(
        new QueryCommand({
          TableName: NOTIFICATIONS_TABLE,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ACTIVE" },
          ScanIndexForward: false,
          Limit: 50,
        })
      );
      return success({ notifications: result.Items || [] }, origin);
    } catch (err) {
      console.error("List notifications error:", err);
      return error(500, "Failed to list notifications", origin);
    }
  }

  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    const sk = event.queryStringParameters?.sk;
    if (!id || !sk) return error(400, "id and sk required", origin);
    try {
      await docClient.send(new DeleteCommand({ TableName: NOTIFICATIONS_TABLE, Key: { PK: "ACTIVE", SK: sk } }));
      return success({ message: "Notification dismissed" }, origin);
    } catch (err) {
      console.error("Dismiss error:", err);
      return error(500, "Failed to dismiss", origin);
    }
  }

  return error(405, "Method not allowed", origin);
};

/**
 * Helper to create a notification (called from other handlers)
 */
export async function createNotification(data: {
  type: Notification["type"];
  businessId: string;
  businessName: string;
  phoneNumberId: string;
  phoneDisplayName: string;
  templateName?: string;
  errorMessage?: string;
  campaignId?: string;
}) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const appealLink = `https://business.facebook.com/wa/manage/message-templates/?waba_id=&business_id=${data.businessId}`;
  const businessManagerLink = `https://business.facebook.com/settings/whatsapp-business-accounts/?business_id=${data.businessId}`;

  await docClient.send(
    new PutCommand({
      TableName: NOTIFICATIONS_TABLE,
      Item: {
        PK: "ACTIVE",
        SK: `TS#${now}#${id}`,
        id,
        type: data.type,
        businessId: data.businessId,
        businessName: data.businessName,
        phoneNumberId: data.phoneNumberId,
        phoneDisplayName: data.phoneDisplayName,
        templateName: data.templateName || "",
        errorMessage: data.errorMessage || "",
        campaignId: data.campaignId || "",
        appealLink,
        businessManagerLink,
        createdAt: now,
        resolved: false,
      },
    })
  );
}
