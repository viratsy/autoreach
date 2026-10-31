import { SQSHandler } from "aws-lambda";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { CSVContact } from "../../lib/types";
import { addCounters } from "../../lib/campaign-stats";
import {
  resolveTemplateForCampaign,
  renderTemplate,
  missingParams,
  toHtml,
  EmailTemplate,
} from "../../lib/email-templates";
import { filterSuppressed, normalizeEmail, unsubscribeFooter } from "../../lib/email-suppression";
import { putEmailRecipients, EmailRecipient } from "../../lib/email-recipients";

const ses = new SESv2Client({});

const FROM_ADDRESS = process.env.REMINDER_FROM_EMAIL || "";
const FROM_NAME = process.env.MENTOR_NAME || "";
const LINK_BASE_URL = process.env.LINK_BASE_URL || "";
// Enables SES open/click tracking and routes the resulting events to SNS.
const CONFIG_SET = process.env.SES_CONFIGURATION_SET || "";

/**
 * SES caps sends per second per account. Going over returns Throttling, which
 * at these volumes would mean thousands of silent drops, so the worker paces
 * itself rather than relying on retries.
 */
const SEND_RATE_PER_SEC = parseInt(process.env.SES_SEND_RATE || "12", 10);

interface EmailJob {
  campaignId: string;
  runKey: string;
  /** Set by campaigns created with the template picker; absent on older ones. */
  emailTemplateId?: string;
  contacts: CSVContact[];
}

/**
 * Sends the email half of a campaign — the same audience, the same moment, the
 * same parameter values as the WhatsApp message, because both read the one CSV
 * row the campaign was built from.
 *
 * A campaign only emails if a template exists for its run key; otherwise this
 * exits quietly and the campaign stays WhatsApp-only.
 */
export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body) as EmailJob;
      await processJob(job);
    } catch (err) {
      console.error("[email-worker] record failed", err);
      // Swallow: a failed email must never hold up or retry the WhatsApp send.
    }
  }
};

async function processJob(job: EmailJob) {
  const { campaignId, runKey, emailTemplateId, contacts } = job;
  if (!FROM_ADDRESS) {
    console.error("[email-worker] REMINDER_FROM_EMAIL not set — skipping");
    return;
  }

  const tpl = await resolveTemplateForCampaign(emailTemplateId, runKey);
  if (!tpl) {
    console.log(
      `[email-worker] no template for campaign ${campaignId} ` +
        `(templateId=${emailTemplateId || "none"} runKey="${runKey}") — stays WhatsApp-only`
    );
    return;
  }

  const campResult = await docClient.send(
    new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
  );
  if (campResult.Item?.status === "cancelled") {
    console.log(`[email-worker] campaign ${campaignId} cancelled — skipping ${contacts.length} emails`);
    return;
  }

  // One batched lookup rather than a read per recipient.
  const withEmail = contacts.filter((c) => {
    const email = normalizeEmail((c as Record<string, string>).email || "");
    return email.includes("@");
  });
  const suppressed = await filterSuppressed(
    withEmail.map((c) => (c as Record<string, string>).email)
  );

  let sent = 0;
  let skipped = contacts.length - withEmail.length;
  let failed = 0;

  // One row per recipient, so the campaign view can say which people were
  // skipped rather than only how many. Collected here and written in one go
  // after the loop — a write per send would triple this worker's runtime.
  const recipients: EmailRecipient[] = [];

  const minInterval = 1000 / Math.max(SEND_RATE_PER_SEC, 1);
  let nextSlot = Date.now();

  for (const contact of withEmail) {
    const row = contact as unknown as Record<string, string>;
    const email = normalizeEmail(row.email);

    // Navin's copy opens "Hi {{name}}," — a blank name would send a literal
    // "Hi ," to a real person. Lead data is ~100% named, but one blank row
    // shouldn't be visible to the recipient.
    if (!(row.name || "").trim()) row.name = "there";

    if (suppressed.has(email)) {
      skipped++;
      recipients.push({
        email,
        phone: row.phone,
        name: row.name,
        emailStatus: "skipped",
        emailReason: "Unsubscribed or previously bounced",
      });
      continue;
    }

    // A "join the zoom call now" email with an empty {{zoom_link}} is worse
    // than not sending at all — it burns reputation for a message that can't
    // work. Skip rather than deliver something broken.
    const missing = missingParams(tpl, row);
    if (missing.length) {
      skipped++;
      recipients.push({
        email,
        phone: row.phone,
        name: row.name,
        emailStatus: "skipped",
        emailReason: `Missing ${missing.join(", ")}`,
      });
      continue;
    }

    // Pace to the account's send rate.
    const wait = nextSlot - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextSlot = Date.now() + minInterval;

    try {
      await sendOne(tpl, row, email, campaignId);
      sent++;
      recipients.push({
        email,
        phone: row.phone,
        name: row.name,
        emailStatus: "sent",
        emailSentAt: new Date().toISOString(),
      });
    } catch (err) {
      failed++;
      recipients.push({
        email,
        phone: row.phone,
        name: row.name,
        emailStatus: "failed",
        emailReason: err instanceof Error ? err.message.slice(0, 200) : "Send failed",
      });
      if (failed <= 3) console.error(`[email-worker] send failed for ${email}`, err);
    }
  }

  // Contacts with no email address at all are counted in `skipped` above but
  // get no row — there is no address to key one on.
  await putEmailRecipients(campaignId, recipients);

  await addCounters(campaignId, {
    emailSentCount: sent,
    emailFailedCount: failed,
    emailSkippedCount: skipped,
  });

  console.log(
    `[email-worker] campaign=${campaignId} runKey=${runKey} sent=${sent} skipped=${skipped} failed=${failed}`
  );
}

async function sendOne(
  tpl: EmailTemplate,
  row: Record<string, string>,
  email: string,
  campaignId: string
) {
  const subject = renderTemplate(tpl.subject, row);
  const body = renderTemplate(tpl.body, row);
  const footer = unsubscribeFooter(email, LINK_BASE_URL);

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: FROM_NAME ? `${FROM_NAME} <${FROM_ADDRESS}>` : FROM_ADDRESS,
      ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
      // Echoed back on every SES event, which is the only way an open or click
      // can be attributed to the campaign that caused it.
      EmailTags: [
        { Name: "campaign_id", Value: campaignId },
        { Name: "email_kind", Value: "campaign" },
      ],
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: body + footer.text, Charset: "UTF-8" },
            Html: { Data: toHtml(body, footer.html), Charset: "UTF-8" },
          },
          // One-click unsubscribe. Gmail and Yahoo require these headers for
          // bulk senders; without them mail gets filtered regardless of content.
          Headers: [
            { Name: "List-Unsubscribe", Value: `<${footer.url}>` },
            { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
          ],
        },
      },
    })
  );
}
