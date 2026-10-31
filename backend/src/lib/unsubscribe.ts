import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";
import { META_ERROR_CODES } from "./error-codes";

const UNSUBSCRIBE_TABLE = process.env.UNSUBSCRIBE_TABLE || `autoreach-unsubscribe-${process.env.ENV_NAME || "hardik"}`;

// Error codes where the problem is permanently on the RECIPIENT's side — their
// number isn't reachable on WhatsApp at all, not a transient delivery hiccup —
// so retrying can never succeed, on this campaign or any future one. Kept
// deliberately narrow to codes that mean exactly that (not merely
// non-retryable in general — e.g. 131048 "blocked/spam" is about this
// business's standing with the recipient, not the recipient's own number).
const PERMANENT_RECIPIENT_ERROR_CODES = new Set([
  "131026", // Not on WhatsApp, using an old WhatsApp version, or hasn't accepted new ToS
]);

export function isPermanentRecipientError(errorCode: string | null | undefined): boolean {
  return !!errorCode && PERMANENT_RECIPIENT_ERROR_CODES.has(errorCode);
}

/**
 * Auto-adds a recipient to the stop/unsubscribe list when their number
 * failed with a permanent, customer-side error — same table respectUnsubscribeList
 * already checks before every send, so once added here, every future
 * campaign (any business) skips them automatically instead of re-sending to
 * a number that will never receive it.
 */
export async function addToStopListIfPermanentRecipientError(phone: string, errorCode: string | null | undefined): Promise<void> {
  if (!isPermanentRecipientError(errorCode)) return;
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return;

  try {
    await docClient.send(
      new PutCommand({
        TableName: UNSUBSCRIBE_TABLE,
        Item: {
          PK: `PHONE#${digits}`,
          phone: digits,
          reason: `Auto-added: ${META_ERROR_CODES[errorCode as string]?.label || "not reachable on WhatsApp"} (error ${errorCode})`,
          unsubscribedAt: new Date().toISOString(),
          source: "auto_permanent_error",
        },
      })
    );
    console.log(`Auto-added ${digits} to stop list (error ${errorCode})`);
  } catch (err) {
    console.error(`Failed to auto-add ${digits} to stop list:`, err);
  }
}
