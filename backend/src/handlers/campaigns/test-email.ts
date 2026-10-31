import { APIGatewayProxyHandler } from "aws-lambda";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { parseCSVWithHeaders } from "../../lib/csv";
import {
  resolveTemplateForCampaign,
  renderTemplate,
  missingParams,
  toHtml,
} from "../../lib/email-templates";
import { unsubscribeFooter, normalizeEmail } from "../../lib/email-suppression";

const ses = new SESv2Client({});
const s3 = new S3Client({});

const FROM_ADDRESS = process.env.REMINDER_FROM_EMAIL || "";
const FROM_NAME = process.env.MENTOR_NAME || "";
const LINK_BASE_URL = process.env.LINK_BASE_URL || "";
// Enables SES open/click tracking and routes the resulting events to SNS.
const CONFIG_SET = process.env.SES_CONFIGURATION_SET || "";
const CSV_BUCKET = process.env.CSV_BUCKET!;

/**
 * Sends one real email, to an address you name.
 *
 * POST /campaigns/{campaignId}/test-email   body: { email, templateId? }
 * POST /campaigns/test-email                body: { email, templateId, csvS3Key }
 *
 * The second form is what the wizard's Test Message step uses: at that point
 * the campaign does not exist yet, so the template and the CSV come from the
 * draft instead of from a saved record. Same rendering either way.
 *
 * Renders from the campaign's own first CSV row rather than sample values, so
 * what arrives is exactly what the audience would get — same workshop name,
 * same date, same zoom link. Deliberately ignores the template's enabled flag
 * and the campaign's emailEnabled toggle: testing is how you decide whether to
 * turn those on.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const campaignId = event.pathParameters?.campaignId || "";

    const req = JSON.parse(event.body || "{}") as {
      email?: string;
      templateId?: string;
      csvS3Key?: string;
    };
    const to = normalizeEmail(req.email || "");
    if (!to.includes("@")) return error(400, "A valid email address is required", origin);
    if (!FROM_ADDRESS) return error(500, "REMINDER_FROM_EMAIL is not configured", origin);

    // Draft mode: no campaign yet, so everything comes from the request.
    let campaign: Record<string, unknown> | undefined;
    if (campaignId) {
      const campResult = await docClient.send(
        new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
      );
      campaign = campResult.Item;
      if (!campaign) return error(404, "Campaign not found", origin);
    } else if (!req.templateId) {
      return error(400, "templateId is required when testing before the campaign is saved", origin);
    }

    // includeDisabled — a test is exactly what you do BEFORE enabling.
    // templateId lets the caller preview a template the campaign has not been
    // saved with yet, which is what the picker needs.
    const tpl = await resolveTemplateForCampaign(
      req.templateId || (campaign?.emailTemplateId as string | undefined),
      campaign?.msg as string | undefined,
      true
    );
    if (!tpl) {
      return error(400, "No email template selected for this campaign", origin);
    }

    // The campaign's own first contact, so the test shows real values.
    let row: Record<string, string> = {};
    const csvKey = (campaign?.csvS3Key as string | undefined) || req.csvS3Key || "";
    if (csvKey) {
      try {
        const obj = await s3.send(
          new GetObjectCommand({ Bucket: CSV_BUCKET, Key: csvKey })
        );
        const { records } = parseCSVWithHeaders(await obj.Body!.transformToString());
        row = (records[0] as Record<string, string>) || {};
      } catch (err) {
        console.warn("[test-email] couldn't read CSV, sending with empty values", err);
      }
    }
    if (!(row.name || "").trim()) row.name = "there";

    const missing = missingParams(tpl, row);
    const subject = renderTemplate(tpl.subject, row);
    const body = renderTemplate(tpl.body, row);
    const footer = unsubscribeFooter(to, LINK_BASE_URL);

    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM_NAME ? `${FROM_NAME} <${FROM_ADDRESS}>` : FROM_ADDRESS,
        ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
        // campaign_id keeps the event traceable; email_kind=test is what stops
        // it being counted. Without the second tag, opening or clicking a test
        // put Clicked/Opened on a campaign showing Sent: 0 — which is exactly
        // how it looked before this.
        // email_kind=test is what keeps this out of the campaign's counters.
        // campaign_id is omitted entirely in draft mode — SES rejects an empty
        // tag value, and there is no campaign to attribute it to yet.
        EmailTags: [
          ...(campaignId ? [{ Name: "campaign_id", Value: campaignId }] : []),
          { Name: "email_kind", Value: "test" },
        ],
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: `[TEST] ${subject}`, Charset: "UTF-8" },
            Body: {
              Text: { Data: body + footer.text, Charset: "UTF-8" },
              Html: { Data: toHtml(body, footer.html), Charset: "UTF-8" },
            },
            Headers: [
              { Name: "List-Unsubscribe", Value: `<${footer.url}>` },
              { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
            ],
          },
        },
      })
    );

    return success(
      {
        sentTo: to,
        templateId: tpl.templateId,
        templateLabel: tpl.name,
        templateEnabled: tpl.enabled !== false,
        subject,
        usedContact: row.name ? `${row.name}${row.email ? ` <${row.email}>` : ""}` : "(no CSV contact)",
        // Surfaced rather than silently skipped: the same gap would make the
        // real send skip every contact missing it.
        missingParams: missing,
      },
      origin
    );
  } catch (err) {
    console.error("[test-email] failed", err);
    return error(500, err instanceof Error ? err.message : "Failed to send test email", origin);
  }
};
