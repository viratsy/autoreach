import { BatchWriteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "./dynamo";
import { normalizeEmail } from "./email-suppression";

/**
 * Per-recipient email outcomes, so a campaign's message list can show what
 * happened to each person's email next to what happened to their WhatsApp
 * message. Before this existed only the aggregate counters did, which could
 * say "667 sent, 15 skipped" but never which 15.
 *
 * These live in the campaign's own partition in the MESSAGES table, keyed
 * EMAIL#<address> alongside the existing MSG#<phone> rows, for two reasons:
 * the campaign view already reads that partition, and an SES event carries the
 * campaign id and the recipient address — which together ARE the key, so a
 * bounce or open needs no lookup to find its row.
 *
 * Two deliberate constraints:
 *
 * 1. No GSI attributes. MESSAGES projects ALL into three indexes, so a row
 *    carrying GSI keys costs four writes instead of one. These rows are only
 *    ever read by campaign partition, never by index, so leaving GSI1PK/GSI3PK/
 *    GSI4PK off keeps them out of all three (a sparse index) and the cost at
 *    1 WRU each.
 *
 * 2. No attribute named `status`. retry-failed.ts and resume.ts query this
 *    partition filtering on `status` = failed/queued to decide what to re-send
 *    over WhatsApp. An email row with status "failed" would be picked up and
 *    re-queued as a WhatsApp message to whatever phone it carried. Calling the
 *    field `emailStatus` makes that impossible rather than merely unlikely.
 */
export type EmailStatus = "sent" | "skipped" | "failed";

export interface EmailRecipient {
  email: string;
  phone?: string;
  name?: string;
  emailStatus: EmailStatus;
  /** Why it was skipped or how it failed — shown in the Reason column. */
  emailReason?: string;
  emailSentAt?: string;
  emailDeliveredAt?: string;
  emailOpenedAt?: string;
  emailClickedAt?: string;
  emailBouncedAt?: string;
  emailComplainedAt?: string;
}

export const emailSK = (email: string) => `EMAIL#${normalizeEmail(email)}`;

/** Message rows are SK MSG#… — used to keep email rows out of message lists. */
export const MSG_SK_PREFIX = "MSG#";

/**
 * Writes one row per recipient. Called once per SQS batch rather than per
 * send, so a 100-contact batch costs 4 BatchWrite calls, not 100 PUTs.
 */
export async function putEmailRecipients(campaignId: string, rows: EmailRecipient[]): Promise<void> {
  const items = rows.filter((r) => r.email);
  for (let i = 0; i < items.length; i += 25) {
    const slice = items.slice(i, i + 25);
    try {
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLES.MESSAGES]: slice.map((r) => ({
              PutRequest: {
                Item: {
                  PK: `CAMP#${campaignId}`,
                  SK: emailSK(r.email),
                  ...r,
                  email: normalizeEmail(r.email),
                },
              },
            })),
          },
        })
      );
    } catch (err) {
      // Losing the audit row must never cost the send itself — by the time
      // this runs the email has already gone out.
      console.error(`[email-recipients] batch write failed for ${campaignId}`, err);
    }
  }
}

/**
 * Records an SES event against the recipient's row, creating it if absent.
 *
 * Upsert rather than update-only: campaigns that sent before per-recipient
 * rows existed still generate opens and clicks for days afterwards, and those
 * events carry the address, so the row they imply is real even though no
 * `emailStatus` was ever written for it. Showing "opened" with no "sent"
 * beside it is a true fact about that recipient and strictly better than a
 * dash. Test sends never reach here — campaignIdFrom drops email_kind=test.
 */
export async function markEmailEvent(
  campaignId: string,
  email: string,
  field: "emailDeliveredAt" | "emailOpenedAt" | "emailClickedAt" | "emailBouncedAt" | "emailComplainedAt",
  reason?: string
): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.MESSAGES,
        Key: { PK: `CAMP#${campaignId}`, SK: emailSK(email) },
        // `email` is set on every event: get.ts joins message rows to these on
        // that attribute, so a row created by an open with no address on it
        // would never be found again.
        UpdateExpression: reason
          ? `SET ${field} = :t, #em = :e, emailReason = :r`
          : `SET ${field} = :t, #em = :e`,
        // Aliased rather than inlined: DynamoDB rejects reserved words in an
        // update expression, and finding out which ones are reserved in
        // production is a poor way to learn.
        ExpressionAttributeNames: { "#em": "email" },
        ExpressionAttributeValues: reason
          ? { ":t": new Date().toISOString(), ":e": normalizeEmail(email), ":r": reason }
          : { ":t": new Date().toISOString(), ":e": normalizeEmail(email) },
      })
    );
  } catch (err) {
    console.error(`[email-recipients] ${field} failed for ${campaignId}/${email}`, err);
  }
}

/** Every email row for a campaign, keyed by normalized address. */
export async function fetchEmailRecipients(campaignId: string): Promise<Map<string, EmailRecipient>> {
  const out = new Map<string, EmailRecipient>();
  let lastKey: Record<string, unknown> | undefined;
  try {
    do {
      const res = await docClient.send(
        new QueryCommand({
          TableName: TABLES.MESSAGES,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":prefix": "EMAIL#" },
          ExclusiveStartKey: lastKey,
        })
      );
      for (const item of res.Items || []) {
        out.set(item.email as string, item as unknown as EmailRecipient);
      }
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  } catch (err) {
    console.error(`[email-recipients] fetch failed for ${campaignId}`, err);
  }
  return out;
}
