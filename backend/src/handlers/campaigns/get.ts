import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { applyStats, fetchStats } from "../../lib/campaign-stats";
import { fetchEmailRecipients, MSG_SK_PREFIX } from "../../lib/email-recipients";
import { calculateActualCost } from "../../lib/pricing";
import { classifyErrorRetryable } from "../../lib/error-codes";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { REPLY_TYPES, ReplyType } from "../../lib/reply-classifier";

/**
 * GET /campaigns/{campaignId}
 * Returns campaign details + metrics.
 * Metrics come from pre-computed counters on the campaign record (fast, no messages scan).
 * For old campaigns without counters, falls back to paginated messages query.
 *
 * GET /campaigns/{campaignId}?status=failed&page=1&limit=50
 * Returns paginated message list filtered by status using GSI3.
 */
/**
 * The email half of a campaign. Counted on the same STATS item as the WhatsApp
 * counters, so these come back merged already — they just need surfacing, which
 * is the step repliedCount famously went years without.
 */
function emailMetrics(campaign: Record<string, unknown>) {
  return {
    emailEnabled: campaign.emailEnabled === true,
    emailTemplateId: (campaign.emailTemplateId as string) || "",
    emailSent: (campaign.emailSentCount as number) || 0,
    emailDelivered: (campaign.emailDeliveredCount as number) || 0,
    emailFailed: (campaign.emailFailedCount as number) || 0,
    emailSkipped: (campaign.emailSkippedCount as number) || 0,
    emailBounced: (campaign.emailBouncedCount as number) || 0,
    emailComplained: (campaign.emailComplainedCount as number) || 0,
    emailOpened: (campaign.emailOpenedCount as number) || 0,
    emailClicked: (campaign.emailClickedCount as number) || 0,
  };
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    const statusFilter = event.queryStringParameters?.status;
    const page = parseInt(event.queryStringParameters?.page || "1");
    const limit = Math.min(parseInt(event.queryStringParameters?.limit || "50"), 200);

    // Get campaign record, plus the sibling STATS item holding the funnel
    // counters (see lib/campaign-stats.ts — they live apart so incrementing one
    // doesn't rewrite the whole 3.8KB config item into both GSIs).
    const [campaignResult, stats] = await Promise.all([
      docClient.send(
        new GetCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
        })
      ),
      fetchStats(campaignId),
    ]);
    const campaign = campaignResult.Item;
    if (!campaign) return error(404, "Campaign not found", origin);
    applyStats(campaign, stats);

    // ── If status filter requested, return paginated message list ──────────
    if (statusFilter) {
      const errorCodeFilter = event.queryStringParameters?.errorCode;

      // "sent"/"delivered" are funnel-cumulative in the metrics counters (a
      // message currently at "read" already passed through both) — the
      // drill-down list has to match that same semantics, or clicking "Sent"
      // shows almost nothing once most messages have progressed past it.
      // "replied" isn't a status at all (repliedAt is a separate attribute,
      // set independent of status), so it can't use GSI3 and needs a
      // full-partition query instead.
      const STATUS_GROUPS: Record<string, string[]> = {
        sent: ["sent", "delivered", "read"],
        delivered: ["delivered", "read"],
        read: ["read"],
        failed: ["failed"],
        skipped: ["skipped"],
      };

      let allItems: Record<string, unknown>[] = [];

      if (statusFilter === "replied" || statusFilter === "all") {
        // Both read the whole campaign partition rather than GSI3: "replied"
        // because repliedAt is an attribute rather than a status, and "all"
        // because every status has to come back including ones GSI3 groups
        // separately (queued, skipped, failed).
        let lastKey: Record<string, unknown> | undefined;
        do {
          const result = await docClient.send(
            new QueryCommand({
              TableName: TABLES.MESSAGES,
              // begins_with pins this to message rows. The same partition also
              // holds the STATS item and one EMAIL#<address> row per email
              // recipient; without this they would show up as phantom rows in
              // the message list and be counted in its total.
              KeyConditionExpression: "PK = :pk AND begins_with(SK, :msgPrefix)",
              ...(statusFilter === "replied"
                ? {
                    FilterExpression: "attribute_type(repliedAt, :strType)",
                    ExpressionAttributeValues: {
                      ":pk": `CAMP#${campaignId}`,
                      ":msgPrefix": MSG_SK_PREFIX,
                      ":strType": "S",
                    },
                  }
                : {
                    ExpressionAttributeValues: {
                      ":pk": `CAMP#${campaignId}`,
                      ":msgPrefix": MSG_SK_PREFIX,
                    },
                  }),
              ExclusiveStartKey: lastKey,
            })
          );
          allItems = allItems.concat(result.Items || []);
          lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
        } while (lastKey);
      } else {
        const statuses = STATUS_GROUPS[statusFilter] || [statusFilter];
        for (const s of statuses) {
          let lastKey: Record<string, unknown> | undefined;
          do {
            const result = await docClient.send(
              new QueryCommand({
                TableName: TABLES.MESSAGES,
                IndexName: "GSI3",
                KeyConditionExpression: "GSI3PK = :gsi3pk",
                ExpressionAttributeValues: { ":gsi3pk": `CAMP#${campaignId}#STATUS#${s}` },
                ExclusiveStartKey: lastKey,
              })
            );
            allItems = allItems.concat(result.Items || []);
            lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
          } while (lastKey);
        }
      }

      // Breakdown by error code — lets the frontend build a "filter by reason"
      // control without a separate round-trip, since we already have every
      // failed message in hand here. errorCodeRetryable rides alongside so the
      // UI can tell which reasons are actually worth offering a retry on (e.g.
      // "not on WhatsApp" never is) instead of only learning that after a retry
      // call silently skips them.
      let errorCodeBreakdown: Record<string, number> | undefined;
      let errorCodeRetryable: Record<string, boolean> | undefined;
      // Skipped rows carry their reason in the same errorCode field
      // ("unsubscribed" / "already_paid" / "campaign_cancelled"), so they get
      // the same breakdown treatment — otherwise the UI can only say "33
      // skipped" without being able to say why any of them were.
      if (statusFilter === "failed" || statusFilter === "skipped") {
        errorCodeBreakdown = {};
        errorCodeRetryable = {};
        for (const m of allItems) {
          const code = (m.errorCode as string) || "Unknown";
          errorCodeBreakdown[code] = (errorCodeBreakdown[code] || 0) + 1;
          if (!(code in errorCodeRetryable)) {
            // A skip is a deliberate suppression, never something to retry.
            errorCodeRetryable[code] =
              statusFilter === "skipped" ? false : code === "Unknown" ? false : classifyErrorRetryable(code);
          }
        }
      }

      // Replied splits by what kind of reply it was (lib/reply-classifier.ts).
      // Rows replied to before classification existed and never backfilled
      // count as "other" — a human-or-unknown reply — rather than vanishing.
      const replyTypeFilter = event.queryStringParameters?.replyType;
      const replyTypeOf = (m: Record<string, unknown>): ReplyType =>
        (REPLY_TYPES as string[]).includes(m.replyType as string) ? (m.replyType as ReplyType) : "other";
      let replyTypeBreakdown: Record<ReplyType, number> | undefined;
      if (statusFilter === "replied") {
        replyTypeBreakdown = { button: 0, auto: 0, other: 0 };
        for (const m of allItems) replyTypeBreakdown[replyTypeOf(m)]++;
      }

      const filteredItems = allItems.filter(
        (m) =>
          (!errorCodeFilter || ((m.errorCode as string) || "Unknown") === errorCodeFilter) &&
          (!replyTypeFilter || statusFilter !== "replied" || replyTypeOf(m) === replyTypeFilter)
      );

      // Paginate in-memory
      const start = (page - 1) * limit;
      const pageItems = filteredItems.slice(start, start + limit);

      // The email half of each contact. Joined on the address in the contact's
      // own CSV row, which is the same row the email was rendered from, so the
      // two halves cannot drift apart. Only fetched when the campaign actually
      // emailed — otherwise every message list would pay for a query that
      // returns nothing.
      const emailRows = campaign.emailEnabled === true
        ? await fetchEmailRecipients(campaignId)
        : new Map();

      return success({
        messages: pageItems.map((m) => {
          const sendingNum = campaign.selectedNumbers?.find(
            (n: { phoneNumberId: string }) => n.phoneNumberId === m.sendingNumberId
          );
          const sendingNumberLabel = sendingNum
            ? sendingNum.displayNumber
              ? `${sendingNum.displayName} (${sendingNum.displayNumber})`
              : sendingNum.displayName
            : m.sendingNumberId || "-";
          const address = String(
            (m.csvRow as Record<string, string> | undefined)?.email || ""
          ).trim().toLowerCase();
          const em = address ? emailRows.get(address) : undefined;

          return {
            phone: m.phoneNumber,
            name: m.contactName,
            status: m.status,
            sendingNumber: sendingNumberLabel,
            errorCode: m.errorCode,
            sentAt: m.sentAt,
            repliedAt: m.repliedAt,
            replyType: m.repliedAt ? replyTypeOf(m) : null,
            replyText: (m.replyText as string) || null,
            email: address || null,
            // Engagement outranks delivery in the label: "clicked" tells you
            // more than "sent", and a bounce matters more than either.
            emailStatus: em
              ? em.emailBouncedAt
                ? "bounced"
                : em.emailComplainedAt
                  ? "spam"
                  : em.emailClickedAt
                    ? "clicked"
                    : em.emailOpenedAt
                      ? "opened"
                      : em.emailDeliveredAt
                        ? "delivered"
                        : em.emailStatus
              : null,
            emailReason: em?.emailReason || null,
          };
        }),
        total: filteredItems.length,
        page,
        totalPages: Math.ceil(filteredItems.length / limit),
        errorCodeBreakdown,
        errorCodeRetryable,
        replyTypeBreakdown,
      }, origin);
    }

    // ── Metrics — use pre-computed counters if available ──────────────────
    // number | boolean because emailEnabled rides along with the counts.
    let metrics: Record<string, number | boolean | string>;

    if (campaign.sentCount != null && campaign.deliveredCount != null) {
      // Fast path — counters written by send-worker + webhook-worker.
      // Each counter is already CUMULATIVE through the funnel (sent → delivered →
      // read): sentCount is incremented once per contact the moment Meta first
      // accepts the message and is never decremented afterward, even once that
      // same contact's status later advances to delivered/read (or async-fails).
      // deliveredCount/readCount behave the same way — incremented whenever a
      // message crosses INTO that stage, never reduced. So sentCount already
      // counts everyone who ever reached delivered/read too; adding d and r on
      // top (as the old formula did) double- and triple-counts them, which is
      // exactly how a campaign could show "sent" percentages over 100%.
      const s  = (campaign.sentCount      as number) || 0;
      const d  = (campaign.deliveredCount as number) || 0;
      const r  = (campaign.readCount      as number) || 0;
      const f  = (campaign.failedCount    as number) || 0;
      const sk = (campaign.skippedCount   as number) || 0;
      metrics = {
        total:     campaign.totalContacts || 0,
        sent:      s,
        delivered: d,
        read:      r,
        failed:    f,
        skipped:   sk,
        queued:    Math.max(0, (campaign.totalContacts || 0) - s - f - sk),
        replied:   (campaign.repliedCount as number) || 0,
        ...emailMetrics(campaign),
      };
    } else {
      // Slow path — old campaign without counters, scan with pagination
      const allMessages: Record<string, unknown>[] = [];
      let lastKey: Record<string, unknown> | undefined = undefined;
      do {
        const result = await docClient.send(
          new QueryCommand({
            TableName: TABLES.MESSAGES,
            // Message rows only — see the note on the list query above.
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :msgPrefix)",
            ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":msgPrefix": MSG_SK_PREFIX },
            ProjectionExpression: "#s, repliedAt",
            ExpressionAttributeNames: { "#s": "status" },
            ExclusiveStartKey: lastKey,
          })
        );
        allMessages.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);

      const byStatus: Record<string, number> = {};
      for (const m of allMessages) { byStatus[m.status as string] = (byStatus[m.status as string] || 0) + 1; }
      const r = byStatus["read"] || 0;
      const d = byStatus["delivered"] || 0;
      const s = byStatus["sent"] || 0;
      metrics = {
        // Audience size, not "how many message records exist yet" — those
        // are the same number once sending is done, but before a campaign
        // has ever run this fell back to allMessages.length (0, since no
        // messages exist yet), showing "Total: 0" for a draft/scheduled
        // campaign that's never sent instead of its real contact count.
        total:     campaign.totalContacts || allMessages.length,
        sent:      s + d + r,
        delivered: d + r,
        read:      r,
        failed:    byStatus["failed"]  || 0,
        skipped:   byStatus["skipped"] || 0,
        queued:    byStatus["queued"]  || 0,
        replied:   allMessages.filter((m) => m.repliedAt).length,
        ...emailMetrics(campaign),
      };
    }

    const templateCategory = campaign.templateCategory || "utility";
    const cost = calculateActualCost(Number(metrics.delivered) || 0, templateCategory);

    // Per-number template details — a campaign can map different (but equivalent)
    // template names per number via templateMappings, and each number's copy of a
    // template can independently drift in category/status (paused, disabled, a
    // MARKETING re-categorization, etc.) even though the campaign only stores one
    // templateName/templateCategory overall. Look up each number's actual current
    // template record so the details page can show what's really live on each one —
    // this is also exactly the info you'd want when cross-checking a "Template
    // disabled"/"Template paused" failure reason shown in the message list.
    const templateByNumber = await Promise.all(
      (campaign.selectedNumbers || []).map(async (num: { phoneNumberId: string; displayName: string; displayNumber?: string }) => {
        const tplName = campaign.templateMappings?.[num.phoneNumberId] || campaign.templateName;
        if (!tplName) return { phoneNumberId: num.phoneNumberId, displayName: num.displayName, displayNumber: num.displayNumber, templateName: null };

        try {
          const tplResult = await docClient.send(
            new GetCommand({
              TableName: TABLES.TEMPLATES,
              Key: { PK: `BIZ#${campaign.businessId}`, SK: `TPL#${num.phoneNumberId}#${tplName}` },
            })
          );
          const tpl = tplResult.Item;
          return {
            phoneNumberId: num.phoneNumberId,
            displayName: num.displayName,
            displayNumber: num.displayNumber,
            templateName: tplName,
            category: tpl?.category || null,
            parameterCount: tpl?.parameterCount ?? null,
            status: tpl?.status || null,
            found: !!tpl,
          };
        } catch {
          return { phoneNumberId: num.phoneNumberId, displayName: num.displayName, displayNumber: num.displayNumber, templateName: tplName, found: false };
        }
      })
    );

    return success({
      campaign: {
        campaignId:     campaign.campaignId,
        campaignName:   campaign.campaignName,
        businessId:     campaign.businessId,
        businessName:   campaign.businessName,
        selectedNumbers: campaign.selectedNumbers,
        templateName:   campaign.templateName,
        templateCategory,
        templateMappings: campaign.templateMappings || {},
        parameterMapping: campaign.parameterMapping || {},
        csvS3Key:       campaign.csvS3Key || "",
        headerImageUrl: campaign.headerImageUrl || "",
        numbersWithImageHeader: campaign.numbersWithImageHeader || [],
        workshop:       campaign.workshop || "",
        batch:          campaign.batch || "",
        msg:            campaign.msg || "",
        failureMode:    campaign.failureMode || "reroute",
        autoRetry:      campaign.autoRetry !== false,
        respectUnsubscribeList: campaign.respectUnsubscribeList !== false,
        excludePaidUsers: campaign.excludePaidUsers !== false,
        totalContacts:  campaign.totalContacts,
        scheduleDate:   campaign.scheduleDate,
        scheduleTime:   campaign.scheduleTime,
        status:         campaign.status,
        createdAt:      campaign.createdAt,
        startedAt:      campaign.startedAt || null,
        completedAt:    campaign.completedAt || null,
      },
      templateByNumber,
      metrics,
      cost,
      estimatedCost: campaign.estimatedCost || null,
    }, origin);
  } catch (err) {
    console.error("Get campaign error:", err);
    return error(500, "Failed to get campaign", origin);
  }
};
