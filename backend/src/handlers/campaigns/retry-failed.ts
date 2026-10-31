import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { docClient, TABLES } from "../../lib/dynamo";
import { addCounters } from "../../lib/campaign-stats";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { createNotification } from "../notifications/index";
import { META_ERROR_CODES, extractKnownErrorCode, NON_RETRYABLE_ERRORS, RETRYABLE_ERRORS } from "../../lib/error-codes";
import { createRetryFailedCampaignIfNeeded } from "../../lib/retry-failed-campaign";

const sqs = new SQSClient({});
const SEND_QUEUE_URL = process.env.SEND_QUEUE_URL || "";

/**
 * Retry failed messages for a campaign.
 * Only retries messages that failed due to retryable errors (template, payment, rate limit).
 * Non-retryable errors (invalid number, blocked) are skipped.
 * 
 * POST /campaigns/{campaignId}/retry
 * Also invoked asynchronously by SendWorkerFunction.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  // A real API Gateway call always populates requestContext; the internal Lambda
  // invokes from send-worker.ts / resume.ts's auto-retry path craft a minimal
  // {httpMethod, pathParameters, headers: {}, body} payload with no requestContext —
  // trust IAM for those and only require a JWT when this came in over HTTP.
  if (event.requestContext && !getAuthEmail(event)) {
    return error(401, "Unauthorized", origin);
  }

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId required", origin);

    // Optional — restrict retry to specific failure reasons, using the exact
    // same bucket key get.ts's errorCodeBreakdown groups by (a message's raw
    // errorCode, or "Unknown" if it has none). Lets the caller pick e.g. only
    // "Template paused" while leaving "Not on WhatsApp" alone, instead of every
    // failed message being funneled through the same retryable/non-retryable
    // classification with no say in which reasons are even worth attempting.
    const { errorCodes: selectedReasons } = JSON.parse(event.body || "{}");
    const reasonFilter: Set<string> | null =
      Array.isArray(selectedReasons) && selectedReasons.length > 0 ? new Set(selectedReasons) : null;

    // Get campaign details
    const campResult = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = campResult.Item;
    if (!campaign) return error(404, "Campaign not found", origin);

    // Get all failed messages
    const failedResult = await docClient.send(
      new QueryCommand({
        TableName: TABLES.MESSAGES,
        KeyConditionExpression: "PK = :pk",
        FilterExpression: "#s = :failed",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":failed": "failed" },
      })
    );

    const allFailedMessages = failedResult.Items || [];
    const failedMessages = reasonFilter
      ? allFailedMessages.filter((m) => reasonFilter.has((m.errorCode as string) || "Unknown"))
      : allFailedMessages;
    console.log(
      `Retry: ${failedMessages.length} failed messages for campaign ${campaignId}` +
        (reasonFilter ? ` (filtered from ${allFailedMessages.length} by ${reasonFilter.size} selected reason(s))` : "")
    );

    if (failedMessages.length === 0) {
      // A reason-filtered request matching nothing says nothing about the OTHER
      // failures still sitting on this campaign (reasonFilter's whole point is to
      // touch only a subset) — only the unfiltered, whole-campaign retry path may
      // conclude "nothing left" and close the campaign out.
      if (!reasonFilter) await markCompleted(campaignId);
      return success({ message: "No failed messages match the selected reason(s)", retried: 0 }, origin);
    }

    // Separate retryable vs non-retryable vs unrecognized. Unrecognized errors are
    // treated as non-retryable (safest default — don't hammer WhatsApp with an error
    // we don't understand), but tracked separately and surfaced via a notification +
    // a distinct response count, instead of silently vanishing into "skipped" with no
    // visibility into why a message never got retried.
    const retryable: typeof failedMessages = [];
    const nonRetryable: typeof failedMessages = [];
    const unrecognized: typeof failedMessages = [];

    for (const msg of failedMessages) {
      const rawErrCode = msg.errorCode || "";
      const errCode = rawErrCode.toLowerCase();

      // Check known numeric Meta error codes first — these can appear either bare
      // ("131042", set by the async delivery-failure webhook) or embedded in a text
      // message ("send-worker.ts" immediate-failure path), and phrase matching alone
      // can never match a bare number.
      const knownCode = extractKnownErrorCode(rawErrCode);

      if (knownCode) {
        if (META_ERROR_CODES[knownCode].retryable) retryable.push(msg);
        else nonRetryable.push(msg);
      } else if (isNonRetryable(errCode)) {
        nonRetryable.push(msg);
      } else if (isRetryable(errCode)) {
        retryable.push(msg);
      } else {
        unrecognized.push(msg);
      }
    }

    console.log(`Retry: ${retryable.length} retryable, ${nonRetryable.length} non-retryable, ${unrecognized.length} unrecognized`);

    if (unrecognized.length > 0) {
      const sampleErrors = [...new Set(unrecognized.map((m) => m.errorCode || "Unknown"))].slice(0, 5).join("; ");
      await createNotification({
        type: "send_failed",
        businessId: campaign.businessId || "",
        businessName: campaign.businessName || "",
        phoneNumberId: "",
        phoneDisplayName: "",
        errorMessage: `${unrecognized.length} failed message(s) had an unrecognized error code and were not retried: ${sampleErrors}`,
        campaignId,
      });
    }

    const skippedCount = nonRetryable.length + unrecognized.length;

    if (retryable.length === 0) {
      // Same reasoning as the empty-failedMessages branch above — a reason-
      // filtered request finding nothing retryable doesn't mean the campaign
      // has nothing else outstanding, so only close it out on the unfiltered path.
      if (!reasonFilter) await markCompleted(campaignId);
      return success({
        message: reasonFilter ? "Selected reason(s) are not retryable" : "No retryable failures, campaign completed",
        retried: 0,
        skipped: skippedCount,
        unrecognized: unrecognized.length,
      }, origin);
    }

    // Get business for access token
    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${campaign.businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) {
      await markCompleted(campaignId);
      return error(500, "Business not found for retry", origin);
    }

    const accessToken = business.accessToken;

    // Group retryable messages by sending number
    const byNumber: Record<string, typeof retryable> = {};
    for (const msg of retryable) {
      const numId = msg.sendingNumberId;
      if (!byNumber[numId]) byNumber[numId] = [];
      byNumber[numId].push(msg);
    }

    // Queue retry batches
    const retryRunId = Date.now();
    for (const [phoneNumberId, messages] of Object.entries(byNumber)) {
      // The whole CSV row rides along, not just phone+name.
      //
      // send-worker writes `csvRow: sanitizeCsvRow(contact)` onto the message
      // row for whatever contact object it is handed. Sending only phone+name
      // here meant a retry OVERWROTE the row's original CSV data with a
      // two-field stub -- so every other template parameter
      // (whatsapp_group, workshop_name, workshop_date_time, ...) became empty.
      // The immediate retry then failed with 131008 "required parameter is
      // missing", and worse, createRetryFailedCampaignIfNeeded later rebuilds
      // its audience FROM msg.csvRow, so the follow-up campaign inherited the
      // stub and failed 100% the same way (700/700 on 4 Oct alone, 28,072
      // failures in a week).
      //
      // phone and name stay last so the message row's own values win over
      // anything stale in the stored row.
      const contacts = messages.map((m) => ({
        ...((m.csvRow as Record<string, string>) || {}),
        phone: m.phoneNumber,
        name: m.contactName || (m.csvRow as Record<string, string> | undefined)?.name || "",
      }));

      // Delete old failed records so they can be re-created
      for (const msg of messages) {
        await docClient.send(
          new UpdateCommand({
            TableName: TABLES.MESSAGES,
            Key: { PK: msg.PK, SK: msg.SK },
            UpdateExpression: "SET #s = :s, errorCode = :null, updatedAt = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":s": "queued", ":null": null, ":now": new Date().toISOString() },
          })
        );
      }

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: SEND_QUEUE_URL,
          MessageGroupId: phoneNumberId,
          MessageDeduplicationId: `retry-${campaignId}-${phoneNumberId}-${retryRunId}`,
          MessageBody: JSON.stringify({
            campaignId,
            templateName: campaign.templateName,
            templateMappings: campaign.templateMappings || {},
            parameterMapping: campaign.parameterMapping || {},
            headerImageUrl: campaign.headerImageUrl || "",
            numbersWithImageHeader: campaign.numbersWithImageHeader || [],
            respectUnsubscribeList: campaign.respectUnsubscribeList !== false,
            excludePaidUsers: campaign.excludePaidUsers !== false,
            accessToken,
            batch: {
              contacts,
              phoneNumberId,
              displayName: "",
            },
          }),
        })
      );
    }

    // One new batch per number above — grow the expected total so send-worker.ts's
    // atomic completedBatches counter can still land on an exact match (same reasoning
    // as resume.ts's re-queue path). Also claw back failedCount for every message
    // being retried: send-worker.ts ADDs sentCount/failedCount by 1 for every send
    // attempt with no awareness of retries, so a message that failed once already
    // incremented failedCount — without this decrement, a retry (success OR another
    // failure) ADDs on top of that instead of replacing it, letting sent+failed grow
    // past totalContacts and skew the campaign's percentages (get.ts's fast-path
    // metrics assume sentCount/failedCount are non-decreasing per-contact tallies —
    // that only holds if a re-attempt first un-counts the outcome it's replacing).
    // totalBatches stays on METADATA — send-worker.ts reads it back alongside
    // completedBatches and status in one ALL_NEW update, so it has to live with
    // them. Only failedCount moves to the STATS sibling.
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
        UpdateExpression: "ADD totalBatches :nb",
        ExpressionAttributeValues: { ":nb": Object.keys(byNumber).length },
      })
    );
    // The same reasoning one comment up, for the other half of the pair.
    //
    // A message Meta ACCEPTED and then failed asynchronously already
    // incremented sentCount: send-worker counts the accept, and webhook-worker
    // deliberately never decrements it ("sentCount is only ever incremented").
    // Retrying that contact increments sentCount a SECOND time for the same
    // person, which is exactly how a 584-contact campaign reports 724 sent
    // (124%) — the excess equalled the auto-retry batch to the message.
    //
    // Only the accepted ones are clawed back: a synchronous rejection never
    // got a metaMessageId and never touched sentCount, so decrementing for
    // those would push the count below the truth instead of onto it.
    const alreadyCountedAsSent = retryable.filter(
      (m) => Boolean((m as { metaMessageId?: string }).metaMessageId)
    ).length;

    await addCounters(campaignId, {
      failedCount: -retryable.length,
      sentCount: -alreadyCountedAsSent,
    });

    console.log(`Retry: Queued ${retryable.length} messages for retry`);
    return success({
      message: "Retry queued",
      retried: retryable.length,
      skipped: skippedCount,
      unrecognized: unrecognized.length,
    }, origin);
  } catch (err) {
    console.error("Retry failed error:", err);
    // Still mark as completed so it doesn't stay running forever
    const campaignId = event.pathParameters?.campaignId;
    if (campaignId) await markCompleted(campaignId);
    return error(500, "Retry failed", origin);
  }
};

function isNonRetryable(errCode: string): boolean {
  return NON_RETRYABLE_ERRORS.some((e) => errCode.includes(e));
}

function isRetryable(errCode: string): boolean {
  return RETRYABLE_ERRORS.some((e) => errCode.includes(e));
}

async function markCompleted(campaignId: string) {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.CAMPAIGNS,
      Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
      UpdateExpression: "SET #status = :s, GSI2PK = :gsi, updatedAt = :now, completedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": "completed",
        ":gsi": "STATUS#completed",
        ":now": new Date().toISOString(),
      },
    })
  );
  console.log(`Campaign ${campaignId} marked as completed`);
  await createRetryFailedCampaignIfNeeded(campaignId);
}
