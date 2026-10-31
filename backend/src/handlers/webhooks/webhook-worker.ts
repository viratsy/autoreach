import { SQSHandler } from "aws-lambda";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { createNotification } from "../notifications/index";
import { lookupBusinessIdByPhoneNumber } from "../../lib/phone-lookup";
import { addToStopListIfPermanentRecipientError } from "../../lib/unsubscribe";
import { CounterBatch, CounterField } from "../../lib/campaign-stats";
import { appendReplyText, classifyReply, mergeReplyType, ReplyType } from "../../lib/reply-classifier";
import { trackCommReply, trackCommStatus } from "../../lib/comm-messages";

const UNSUBSCRIBE_TABLE = process.env.UNSUBSCRIBE_TABLE || `autoreach-unsubscribe-${process.env.ENV_NAME || "hardik"}`;
const UNSUBSCRIBE_KEYWORDS = ["stop", "unsubscribe", "opt out", "optout", "cancel", "remove me", "don't send", "dont send"];

/**
 * Async webhook processor — reads from SQS, handles status updates and incoming messages.
 * Processes in batches for throughput.
 */
export const handler: SQSHandler = async (event) => {
  // A campaign's status webhooks all arrive together, so a single invocation
  // used to write the same campaign record dozens of times to add up to a
  // handful of increments. Tally them here and write once per campaign at the
  // end instead — the same pattern send-worker.ts already uses for its own
  // send-side counters.
  const counters = new CounterBatch();

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body);
      // Log raw payload so we can see exactly what Meta sends
      console.log("WEBHOOK_PAYLOAD:", JSON.stringify(body));
      const entries = body.entry || [];

      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          // Handle message status updates
          const statuses = change.value?.statuses || [];
          for (const status of statuses) {
            await processStatusUpdate(status, counters);
          }

          // Handle incoming messages
          const messages = change.value?.messages || [];
          const metadata = change.value?.metadata;
          for (const msg of messages) {
            let messageText = "";
            if (msg.type === "text" && msg.text?.body) {
              messageText = msg.text.body;
            } else if (msg.type === "interactive") {
              messageText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
            } else if (msg.type === "button") {
              messageText = msg.button?.text || "";
            }

            if (messageText) {
              await checkUnsubscribe(msg.from, messageText);
              // Track reply on campaign messages
              const isButton = msg.type === "button" || msg.interactive?.type === "button_reply";
              await trackCampaignReply(msg.from, messageText, isButton, counters);
              if (msg.context?.id) {
                try {
                  await trackCommReply(msg.context.id, messageText);
                } catch (commErr) {
                  console.error("comm_messages reply update failed (non-fatal):", commErr);
                }
              }
              try {
                await triggerFlowEngine({ ...msg, text: { body: messageText } }, metadata);
              } catch (flowErr) {
                console.error("Flow engine error (non-fatal):", flowErr);
              }
            }
          }

          // Handle template category updates
          if (change.field === "template_category_update") {
            await processTemplateCategoryUpdate(change.value, entry.id);
          }

          // Handle phone number quality rating changes
          if (change.field === "phone_number_quality_update") {
            try {
              await processPhoneNumberQualityUpdate(change.value, entry.id);
            } catch (qualityErr) {
              console.error("Phone number quality update error (non-fatal):", qualityErr);
            }
          }
        }
      }
    } catch (err) {
      console.error("Webhook worker error:", err);
      // Don't throw — let the message be deleted from queue
    }
  }

  // Outside the per-record loop so one flush covers the whole batch. Every
  // record is already committed at the message level by this point, so this
  // must run even if a record threw above — hence its own try/catch rather
  // than riding on one of theirs.
  try {
    await counters.flush();
  } catch (err) {
    console.error("Counter flush failed:", err);
  }
};

// Funnel order used to decide whether an incoming status is real forward
// progress (webhooks can arrive out of order, or a "delivered" event can be
// lost entirely — a later "read" or a reply still proves every earlier stage
// happened too, so we advance through and credit each stage that was skipped
// rather than only the one stage we were directly told about).
const STATUS_ORDER = ["queued", "sent", "delivered", "read"];
const STATUS_COUNTER: Record<string, CounterField> = { delivered: "deliveredCount", read: "readCount" };

async function advanceMessageStatus(
  message: Record<string, unknown>,
  targetStatus: "delivered" | "read",
  counters: CounterBatch
) {
  const currentIndex = STATUS_ORDER.indexOf(message.status as string);
  const targetIndex = STATUS_ORDER.indexOf(targetStatus);
  // currentIndex === -1 means the message is in a state outside this funnel
  // (e.g. "failed", "skipped") — leave those alone rather than guessing.
  if (currentIndex === -1 || targetIndex <= currentIndex) return;

  const now = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.MESSAGES,
      Key: { PK: message.PK, SK: message.SK },
      UpdateExpression: "SET #status = :status, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": targetStatus,
        ":gsi3pk": `${message.PK}#STATUS#${targetStatus}`,
        ":gsi3sk": message.SK,
        ":now": now,
      },
    })
  );

  // Not every Messages row belongs to a campaign — test-send tracking records
  // use PK "TESTSEND#<messageId>" (see test-send.ts). Blindly stripping a
  // "CAMP#" prefix that isn't there previously wrote bogus rows like
  // "CAMP#TESTSEND#<id>" into the Campaigns table, which then showed up as
  // blank entries in the campaigns list. Skip the rollup entirely for those.
  const pk = message.PK as string;
  if (!pk.startsWith("CAMP#")) return;
  const campaignId = pk.replace("CAMP#", "");
  // Tallied rather than written here — the batch is flushed once at the end of
  // the invocation. Failures are still logged, by CounterBatch.flush().
  for (let i = currentIndex + 1; i <= targetIndex; i++) {
    const counterName = STATUS_COUNTER[STATUS_ORDER[i]];
    if (!counterName) continue;
    counters.add(campaignId, counterName);
  }
}

async function processStatusUpdate(
  status: {
    id: string;
    status: string;
    timestamp: string;
    errors?: { code: number; title: string }[];
  },
  counters: CounterBatch
) {
  const metaMessageId = status.id;
  const newStatus = status.status;
  console.log(`STATUS_UPDATE: msgId=${metaMessageId} status=${newStatus}`);

  const queryResult = await docClient.send(
    new QueryCommand({
      TableName: TABLES.MESSAGES,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `METAMSG#${metaMessageId}` },
    })
  );

  const message = queryResult.Items?.[0];
  if (!message) {
    // Not an AutoReach message — may be a signup confirmation logged in
    // comm_messages by free_workshop_meta. Best-effort: never fail the batch.
    try {
      await trackCommStatus(status);
    } catch (err) {
      console.error("comm_messages status update failed (non-fatal):", err);
    }
    return;
  }

  if (newStatus === "delivered" || newStatus === "read") {
    await advanceMessageStatus(message, newStatus, counters);
    return;
  }

  if (newStatus === "failed") {
    const now = new Date().toISOString();
    const exprValues: Record<string, unknown> = {
      ":status": "failed",
      ":gsi3pk": `${message.PK}#STATUS#failed`,
      ":gsi3sk": message.SK,
      ":now": now,
    };
    if (status.errors?.[0]) exprValues[":errorCode"] = String(status.errors[0].code);

    // Permanent, customer-side failure (not on WhatsApp / old WhatsApp
    // version) reported asynchronously — same auto-stop-list treatment as
    // send-worker.ts's immediate-failure path.
    if (status.errors?.[0]) {
      await addToStopListIfPermanentRecipientError(message.phoneNumber as string, String(status.errors[0].code));
    }

    // Meta can accept a message optimistically — sentCount (or deliveredCount/
    // readCount, if it progressed further) already incremented — only to have
    // the actual delivery fail later via this async webhook. Capture which
    // stage it was in BEFORE overwriting status, so the campaign counters stay
    // mutually exclusive instead of double-counting the same contact in both
    // that stage and failedCount forever (this is exactly what caused "Sent"
    // to read ~100% while Failed was also non-zero, summing past total).
    const prevStatus = message.status as string;

    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.MESSAGES,
        Key: { PK: message.PK, SK: message.SK },
        UpdateExpression: "SET #status = :status, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk, errorCode = :errorCode, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: exprValues,
      })
    );

    const pk = message.PK as string;
    if (!pk.startsWith("CAMP#")) return; // test-send tracking record, not a real campaign
    const campaignId = pk.replace("CAMP#", "");
    try {
      // "sent" is deliberately NOT in this map: Sent is meant to mean "everyone
      // we ever triggered, including eventual failures" (so Total = Sent +
      // Skipped always holds), not "currently sitting at sent-and-nothing-more".
      // sentCount is only ever incremented, never decremented — Failed is a
      // breakdown WITHIN Sent, not a sibling bucket added on top of it.
      // Delivered/Read stay exclusive, though: if a message that had already
      // progressed past "sent" later fails, it needs to come OUT of that
      // bucket so Delivered/Read still mean "currently confirmed at that
      // stage" and Delivered % of Total stays accurate.
      const DECREMENT_COUNTER: Record<string, CounterField> = { delivered: "deliveredCount", read: "readCount" };
      const counterToDecrement = DECREMENT_COUNTER[prevStatus];
      // Signed deltas, so the tally nets out correctly when a batch contains
      // both a "delivered" and a later "failed" for the same campaign.
      counters.add(campaignId, "failedCount", 1);
      if (counterToDecrement) counters.add(campaignId, counterToDecrement, -1);
    } catch (err) {
      console.error(`Campaign counter tally failed for ${campaignId} (counter=failedCount):`, err);
    }
  }
}

async function processTemplateCategoryUpdate(value: {
  message_template_name?: string;
  new_category?: string;
}, wabaid: string) {
  const templateName = value.message_template_name;
  const newCategory = value.new_category;
  if (!templateName || !newCategory) return;
  console.log(`Template category update: ${templateName} → ${newCategory} (WABA: ${wabaid})`);
}

const QUALITY_RANK: Record<string, number> = { GREEN: 2, YELLOW: 1, RED: 0, UNKNOWN: 2 };

/**
 * Meta's phone_number_quality_update webhook fires the moment a number's
 * quality tier shifts, but the payload itself only reliably carries
 * display_phone_number/event/current_limit — not a guaranteed quality_rating
 * enum across API versions. Rather than parse a shape that might drift, treat
 * the webhook purely as a trigger: re-fetch this one number's live
 * quality_rating from Meta (the same call businesses/quality-check.ts already
 * trusts), persist it, and notify on a real downgrade — so a RED/YELLOW drop
 * is caught within seconds instead of only being discovered whenever someone
 * next clicks "Check Quality" or a campaign starts failing with 132015.
 */
async function processPhoneNumberQualityUpdate(
  value: { display_phone_number?: string; event?: string; current_limit?: string },
  wabaId: string
) {
  console.log(`PHONE_QUALITY_UPDATE: waba=${wabaId} display=${value.display_phone_number} event=${value.event} limit=${value.current_limit}`);

  const displayDigits = (value.display_phone_number || "").replace(/\D/g, "");
  if (!displayDigits) return;

  // No lookup table indexes wabaid/displayNumber (only phoneNumberId, for the
  // much hotter inbound-message path) — this event is rare enough that a full
  // scan here is cheap, same fallback pattern triggerFlowEngine already uses.
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const allBiz = await docClient.send(new ScanCommand({ TableName: TABLES.BUSINESSES }));

  for (const biz of allBiz.Items || []) {
    const numbers = (biz.phoneNumbers || []) as Record<string, unknown>[];
    const matched = numbers.find(
      (n) => n.wabaid === wabaId && ((n.displayNumber as string) || "").replace(/\D/g, "") === displayDigits
    );
    if (!matched) continue;

    const phoneNumberId = matched.phoneNumberId as string;
    const prevRating = (matched.qualityRating as string) || "UNKNOWN";
    const accessToken = biz.accessToken as string;

    let newRating = "UNKNOWN";
    let newLimit = value.current_limit || "";
    try {
      const res = await fetch(
        `https://graph.facebook.com/v25.0/${phoneNumberId}?fields=quality_rating,messaging_limit_tier`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = (await res.json()) as { quality_rating?: string; messaging_limit_tier?: string };
      newRating = data.quality_rating || "UNKNOWN";
      newLimit = data.messaging_limit_tier || newLimit;
    } catch (err) {
      console.error(`Quality re-fetch failed for ${phoneNumberId}:`, err);
      return;
    }

    const updatedNumbers = numbers.map((n) =>
      n.phoneNumberId === phoneNumberId ? { ...n, qualityRating: newRating, messagingLimit: newLimit } : n
    );
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.BUSINESSES,
        Key: { PK: `BIZ#${biz.businessId}`, SK: "METADATA" },
        UpdateExpression: "SET phoneNumbers = :numbers, updatedAt = :now",
        ExpressionAttributeValues: { ":numbers": updatedNumbers, ":now": new Date().toISOString() },
      })
    );

    console.log(`Quality updated: ${phoneNumberId} ${prevRating} → ${newRating} (business=${biz.businessId})`);

    // Only notify on a genuine downgrade, or landing at RED outright — an
    // upgrade or a same-tier re-notification from Meta shouldn't page anyone.
    if (QUALITY_RANK[newRating] < QUALITY_RANK[prevRating] || newRating === "RED") {
      await createNotification({
        type: "quality_issue",
        businessId: biz.businessId as string,
        businessName: (biz.businessName as string) || "",
        phoneNumberId,
        phoneDisplayName: (matched.displayName as string) || value.display_phone_number || "",
        errorMessage: `Quality rating dropped from ${prevRating} to ${newRating}${newLimit ? ` (messaging limit: ${newLimit})` : ""}`,
      });
    }
    return;
  }

  console.log(`PHONE_QUALITY_UPDATE: no matching business found for waba=${wabaId} display=${value.display_phone_number}`);
}

async function checkUnsubscribe(from: string, text: string) {
  const lower = text.toLowerCase().trim();
  const isUnsubscribe = UNSUBSCRIBE_KEYWORDS.some((kw) => lower.includes(kw));
  if (!isUnsubscribe) return;

  const phone = from.replace(/\D/g, "");
  console.log(`Unsubscribe detected from ${phone}: "${text}"`);

  try {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await docClient.send(
      new PutCommand({
        TableName: UNSUBSCRIBE_TABLE,
        Item: {
          PK: `PHONE#${phone}`,
          phone,
          reason: text,
          unsubscribedAt: new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    console.error("Failed to save unsubscribe:", err);
  }
}

async function triggerFlowEngine(
  msg: { from: string; text?: { body: string }; id?: string },
  metadata?: { phone_number_id?: string; display_phone_number?: string }
) {
  try {
    const { handleIncomingMessage } = await import("../flows/execute");
    const phone = msg.from.replace(/\D/g, "");
    const phoneNumberId = metadata?.phone_number_id || "";

    // Fast path: PhoneLookupTable (maintained by businesses/create.ts + update.ts).
    let businessId = await lookupBusinessIdByPhoneNumber(phoneNumberId);

    // Fallback for businesses saved before this lookup table existed (their
    // phoneNumbers were never backfilled into it) — full scan, same as before.
    if (!businessId) {
      const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
      const allBiz = await docClient.send(new ScanCommand({ TableName: TABLES.BUSINESSES }));
      for (const biz of allBiz.Items || []) {
        const numbers = biz.phoneNumbers || [];
        if (numbers.some((n: any) => n.phoneNumberId === phoneNumberId)) {
          businessId = biz.businessId || "";
          console.warn(`Flow engine: businessId ${businessId} for ${phoneNumberId} found via Scan fallback — lookup table needs backfill (re-save the business to populate it)`);
          break;
        }
      }
    }

    if (!businessId) {
      console.log(`Flow engine: No business found for phoneNumberId ${phoneNumberId}`);
      return;
    }

    await handleIncomingMessage({
      phone,
      phoneNumberId,
      text: msg.text?.body || "",
      contactName: "",
      metaMessageId: msg.id || "",
      businessId,
    });
  } catch (err) {
    console.error("Flow engine trigger error:", err);
  }
}

/**
 * Track campaign reply — when someone replies, find their most recent campaign message,
 * stamp repliedAt and record what kind of reply it was (button tap / auto-reply / other,
 * see lib/reply-classifier.ts) so the Replied drill-down can split real intent from noise.
 *
 * Only the first reply counts toward repliedCount. Later replies to the same message just
 * refine its classification — e.g. an instant business auto-reply followed an hour later
 * by the person tapping the button upgrades the row from "auto" to "button".
 */
async function trackCampaignReply(from: string, text: string, isButton: boolean, counters: CounterBatch) {
  const phone = from.replace(/\D/g, "");

  try {
    // GSI4 (GSI4PK = PHONE#<phone>, GSI4SK = sentAt) lets us find this contact's
    // most recent message across all campaigns without scanning the whole table.
    // Deliberately the newest message whether or not it was already replied to:
    // a second reply belongs to the same conversation, and used to be pinned on
    // some older, unreplied campaign instead.
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLES.MESSAGES,
        IndexName: "GSI4",
        KeyConditionExpression: "GSI4PK = :pk",
        ExpressionAttributeValues: { ":pk": `PHONE#${phone}` },
        ScanIndexForward: false, // newest first
        Limit: 1,
      })
    );

    const latest = result.Items?.[0];
    if (!latest) return;

    const now = new Date().toISOString();
    const replyType = classifyReply({ text, isButton, sentAt: latest.sentAt as string | undefined, repliedAt: now });

    if (!latest.repliedAt) {
      // Conditional so two replies racing each other can't both claim the
      // same message and double-count it below.
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: TABLES.MESSAGES,
            Key: { PK: latest.PK, SK: latest.SK },
            UpdateExpression: "SET repliedAt = :now, replyType = :type, replyText = :text",
            ConditionExpression: "attribute_not_exists(repliedAt) OR repliedAt = :null",
            ExpressionAttributeValues: {
              ":now": now,
              ":null": null,
              ":type": replyType,
              ":text": appendReplyText(null, text),
            },
          })
        );
      } catch (err) {
        if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
        // Lost the race to another reply — fold this one into its classification.
        await refineReply(latest, replyType, text);
        return;
      }

      // Roll the reply up onto the campaign. Every other funnel stage keeps a
      // cached counter (advanceMessageStatus maintains deliveredCount and
      // readCount), but repliedCount was only ever READ — never written — so
      // the Replies stat showed 0 on every campaign while the drill-down,
      // which queries the message rows directly, showed the real number.
      const pk = latest.PK as string;
      if (pk.startsWith("CAMP#")) {
        counters.add(pk.replace("CAMP#", ""), "repliedCount");
      }

      // A reply is direct proof the message was delivered and read, even if
      // Meta's delivered/read status webhooks never arrived or arrived late —
      // so replying should never leave a message looking stuck at "sent".
      await advanceMessageStatus(latest, "read", counters);
      console.log(`Reply tracked: ${phone} → ${latest.PK} (${replyType})`);
    } else {
      await refineReply(latest, replyType, text);
    }
  } catch (err) {
    // Non-critical — don't fail the webhook processing
    console.error("Reply tracking error:", err);
  }
}

/** A follow-up reply on an already-replied message: keep the strongest classification, append the text. */
async function refineReply(message: Record<string, unknown>, replyType: ReplyType, text: string) {
  // Fresh read for the text append; the GSI copy we found the row through can lag.
  const current = await docClient.send(
    new GetCommand({
      TableName: TABLES.MESSAGES,
      Key: { PK: message.PK, SK: message.SK },
      ProjectionExpression: "replyType, replyText",
    })
  );
  const row = current.Item || {};
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.MESSAGES,
      Key: { PK: message.PK, SK: message.SK },
      UpdateExpression: "SET replyType = :type, replyText = :text",
      ExpressionAttributeValues: {
        ":type": mergeReplyType(row.replyType as ReplyType | undefined, replyType),
        ":text": appendReplyText(row.replyText as string | undefined, text),
      },
    })
  );
}
