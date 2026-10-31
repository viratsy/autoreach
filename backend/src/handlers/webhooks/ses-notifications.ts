import { SNSHandler } from "aws-lambda";
import { suppress } from "../../lib/email-suppression";
import { addCounters, CounterField } from "../../lib/campaign-stats";
import { markEmailEvent } from "../../lib/email-recipients";

/**
 * SES bounce and complaint notifications, delivered via SNS.
 *
 * This is the part that keeps the sending identity alive. AWS suspends an
 * account whose hard-bounce rate passes ~5% or complaint rate ~0.1%, and a
 * suspension takes down every email the account sends — OTP logins included,
 * which would lock everyone out of AutoReach itself. So anything that hard
 * bounces or complains is suppressed immediately and never retried.
 *
 * Soft bounces (mailbox full, server down) are deliberately NOT suppressed:
 * they're transient, and permanently dropping those addresses would quietly
 * shrink the list over time.
 */
interface SesNotification {
  notificationType?: string;
  eventType?: string;
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[];
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: { emailAddress?: string }[];
  };
  // SES stamps these on every event when the send carried message tags, which
  // is how an open or click finds its way back to the campaign that caused it.
  // destination carries the recipient addresses, which is how a delivery,
  // open or click finds the per-recipient row it belongs to.
  mail?: { tags?: Record<string, string[]>; destination?: string[] };
}

/**
 * The campaignId message tag SES echoes back on every event — but only for
 * real campaign sends. A test send carries email_kind=test and must not move
 * the campaign's counters, or a scheduled campaign that has sent nothing shows
 * Clicked/Opened from someone checking their own test mail.
 */
function campaignIdFrom(msg: SesNotification): string {
  if (msg.mail?.tags?.email_kind?.[0] === "test") return "";
  return msg.mail?.tags?.campaign_id?.[0] || "";
}

export const handler: SNSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      const msg = JSON.parse(record.Sns.Message) as SesNotification;
      const kind = (msg.notificationType || msg.eventType || "").toLowerCase();

      if (kind === "bounce" && msg.bounce) {
        const permanent = (msg.bounce.bounceType || "").toLowerCase() === "permanent";
        for (const r of msg.bounce.bouncedRecipients || []) {
          if (!r.emailAddress) continue;
          if (!permanent) {
            console.log(`[ses] transient bounce for ${r.emailAddress} (${msg.bounce.bounceSubType}) — not suppressing`);
            continue;
          }
          await suppress(r.emailAddress, "bounce", `${msg.bounce.bounceSubType || ""} ${r.diagnosticCode || ""}`.trim());
          const campaignId = campaignIdFrom(msg);
          if (campaignId) {
            await addCounters(campaignId, { emailBouncedCount: 1 });
            await markEmailEvent(
              campaignId,
              r.emailAddress,
              "emailBouncedAt",
              `Bounced: ${msg.bounce.bounceSubType || "permanent"}`
            );
          }
          console.log(`[ses] suppressed hard bounce ${r.emailAddress}`);
        }
      } else if (kind === "open" || kind === "click" || kind === "delivery") {
        const campaignId = campaignIdFrom(msg);
        if (campaignId) {
          const FIELD: Record<string, CounterField> = {
            open: "emailOpenedCount",
            click: "emailClickedCount",
            // SES confirms acceptance by the receiving server. Distinct from
            // "sent", which only means we handed it to SES.
            delivery: "emailDeliveredCount",
          };
          await addCounters(campaignId, { [FIELD[kind]]: 1 });

          const AT: Record<string, "emailDeliveredAt" | "emailOpenedAt" | "emailClickedAt"> = {
            open: "emailOpenedAt",
            click: "emailClickedAt",
            delivery: "emailDeliveredAt",
          };
          for (const to of msg.mail?.destination || []) {
            await markEmailEvent(campaignId, to, AT[kind]);
          }
        }
      } else if (kind === "complaint" && msg.complaint) {
        for (const r of msg.complaint.complainedRecipients || []) {
          if (!r.emailAddress) continue;
          await suppress(r.emailAddress, "complaint", msg.complaint.complaintFeedbackType || "");
          const campaignId = campaignIdFrom(msg);
          if (campaignId) {
            await addCounters(campaignId, { emailComplainedCount: 1 });
            await markEmailEvent(campaignId, r.emailAddress, "emailComplainedAt", "Marked as spam");
          }
          console.log(`[ses] suppressed complaint ${r.emailAddress}`);
        }
      }
    } catch (err) {
      console.error("[ses] notification failed", err);
    }
  }
};
