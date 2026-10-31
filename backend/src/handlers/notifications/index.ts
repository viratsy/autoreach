import { APIGatewayProxyHandler } from "aws-lambda";
import { UpdateCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE || "autoreach-notifications-hardik";

export interface Notification {
  PK: string; // NOTIF#<id>
  SK: string; // DEDUP#<type>#<businessId>#<phoneNumberId>#<templateName>#<errorMessage> — stable per distinct issue
  id: string;
  type: "template_marketing" | "send_failed" | "quality_issue" | "payment_issue" | "campaign_stuck" | "retry_campaign_created" | "number_removed";
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
  lastSeenAt: string;
  occurrenceCount: number;
  resolved: boolean;
}

/**
 * GET /notifications - list active notifications
 * DELETE /notifications?id=xxx&sk=xxx - dismiss/resolve a notification
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  if (event.httpMethod === "GET") {
    try {
      const result = await docClient.send(
        new QueryCommand({
          TableName: NOTIFICATIONS_TABLE,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ACTIVE" },
        })
      );
      // SK is a stable dedup key (not chronological), so sort by recency in-app.
      const items = (result.Items || []).sort((a, b) => {
        const ta = a.lastSeenAt || a.createdAt || "";
        const tb = b.lastSeenAt || b.createdAt || "";
        return tb.localeCompare(ta);
      });
      return success({ notifications: items.slice(0, 50) }, origin);
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
 * Helper to create a notification (called from other handlers).
 *
 * Deduplicated by (type, businessId, phoneNumberId, templateName, errorMessage): repeated
 * calls with the same signature update the same row (bumping occurrenceCount + lastSeenAt)
 * instead of inserting a new one. Without this, a single campaign failing on hundreds of
 * contacts would create hundreds of near-identical rows and crowd out everything else.
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
  // 90 days out, refreshed on every occurrence so a recurring issue doesn't expire
  // while still actively happening. Table-level TTL isn't enabled yet — see
  // scripts/enable-notifications-ttl.sh — but writing this attribute now is
  // harmless either way and means enabling TTL later needs no backfill.
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
  const appealLink = `https://business.facebook.com/wa/manage/message-templates/?waba_id=&business_id=${data.businessId}`;
  const businessManagerLink = `https://business.facebook.com/settings/whatsapp-business-accounts/?business_id=${data.businessId}`;

  const dedupKey = [
    data.type,
    data.businessId,
    data.phoneNumberId || "-",
    data.templateName || "-",
    (data.errorMessage || "").slice(0, 150),
  ].join("#");

  await docClient.send(
    new UpdateCommand({
      TableName: NOTIFICATIONS_TABLE,
      Key: { PK: "ACTIVE", SK: `DEDUP#${dedupKey}` },
      UpdateExpression:
        "SET id = if_not_exists(id, :id), #type = :type, businessId = :bid, businessName = :bname, " +
        "phoneNumberId = :pnid, phoneDisplayName = :pdname, templateName = :tpl, errorMessage = :err, " +
        "campaignId = :camp, appealLink = :appeal, businessManagerLink = :bmlink, " +
        "createdAt = if_not_exists(createdAt, :now), lastSeenAt = :now, resolved = :false, #ttl = :ttl " +
        "ADD occurrenceCount :one",
      // "ttl" and "type" are both DynamoDB reserved words in expression
      // syntax — must be aliased or the whole UpdateCommand throws
      // ValidationException. ttl was unaliased here (added later, for a
      // not-yet-enabled table TTL — see the ttl comment above), so every
      // createNotification call since has been silently failing: every
      // caller wraps this in a try/catch specifically so a notification
      // failure never masks the real error it's reporting on, which also
      // meant this had no visible symptom besides new notifications quietly
      // never landing. Confirmed live against a real table.
      ExpressionAttributeNames: { "#type": "type", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":id": id,
        ":ttl": ttl,
        ":type": data.type,
        ":bid": data.businessId,
        ":bname": data.businessName,
        ":pnid": data.phoneNumberId,
        ":pdname": data.phoneDisplayName,
        ":tpl": data.templateName || "",
        ":err": data.errorMessage || "",
        ":camp": data.campaignId || "",
        ":appeal": appealLink,
        ":bmlink": businessManagerLink,
        ":now": now,
        ":false": false,
        ":one": 1,
      },
    })
  );
}
