import { SQSHandler } from "aws-lambda";
import { PutCommand, GetCommand, UpdateCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { addCounters } from "../../lib/campaign-stats";
import { CSVContact, PhoneNumber } from "../../lib/types";
import { createNotification } from "../notifications/index";
import { getProvider } from "../../lib/providers";
import { createRetryFailedCampaignIfNeeded } from "../../lib/retry-failed-campaign";
import { addToStopListIfPermanentRecipientError } from "../../lib/unsubscribe";

// DynamoDB rejects any attribute with an empty-string key ("Empty attribute
// name"). A CSV with a stray trailing comma in its header row (e.g.
// "name,email,phone,,,,") parses into contact objects carrying a "" key —
// spreading that straight into csvRow crashes every single write for the
// whole campaign, forever, since the exception isn't caught anywhere up the
// call chain. Strip it here so a malformed CSV can never take down sending.
function sanitizeCsvRow(contact: CSVContact): CSVContact {
  if (!("" in contact)) return contact;
  const { "": _blank, ...rest } = contact;
  return rest as CSVContact;
}

// A large campaign's ~50 concurrent workers all hit the SAME campaign item
// (one PK+SK) for every counter/completedBatches update — a textbook DynamoDB
// hot-key, confirmed against real production logs: 3,179 ThrottlingExceptions
// in one day, 21 of which permanently stranded one campaign's
// completedBatches at 139/160 forever (the AWS SDK's own retries — 3
// attempts — had already been exhausted by the time it reached here). Retry
// throttling specifically, with jittered backoff, so a burst at campaign
// start doesn't permanently drop a write the way the un-retried version did.
async function withThrottleRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const name = (err as { name?: string })?.name;
      if (name !== "ThrottlingException" && name !== "ProvisionedThroughputExceededException") throw err;
      const delayMs = Math.min(2000, 100 * 2 ** attempt) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Worker: Processes a batch of ~200 contacts from SQS.
 * 1. Writes all contacts as "queued" BEFORE sending (crash-safe checkpoint)
 * 2. Checks template category
 * 3. Sends messages via Meta API
 * 4. Updates each record to sent/failed/skipped
 */
export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const {
      campaignId,
      provider,
      templateName,
      templateMappings,
      parameterMapping,
      headerImageUrl,
      numbersWithImageHeader,
      respectUnsubscribeList,
      excludePaidUsers,
      accessToken,
      batch,
      isResume,
    } = JSON.parse(record.body);

    // Messages queued before these fields existed have neither key at all —
    // undefined must mean "check" (the only behavior that ever existed for
    // respectUnsubscribeList; excludePaidUsers is new but follows the same
    // undefined-means-true convention for consistency).
    const shouldRespectUnsubscribeList = respectUnsubscribeList !== false;
    const shouldExcludePaidUsers = excludePaidUsers !== false;

    const { contacts, phoneNumberId, wabaid, apiKey, source, endpoint } = batch as {
      contacts: CSVContact[];
      phoneNumberId: string;
      displayName: string;
      wabaid?: string;
      apiKey?: string;
      source?: string;
      endpoint?: string;
    };

    console.log(`Worker: ${contacts.length} contacts for ${phoneNumberId} in campaign ${campaignId}`);

    // ── CANCEL CHECK: skip the whole batch if the campaign was cancelled ───
    // One read per SQS batch (not per-message) so this stays cheap. This is what
    // makes cancel.ts actually stop messages that were already queued in SQS
    // before the cancel happened, instead of silently sending them anyway.
    const campCheck = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    if (campCheck.Item?.status === "cancelled") {
      console.log(`Skipping batch for cancelled campaign ${campaignId}`);
      const now = new Date().toISOString();
      const DYNAMO_BATCH = 25;
      for (let i = 0; i < contacts.length; i += DYNAMO_BATCH) {
        const slice = contacts.slice(i, i + DYNAMO_BATCH);
        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [TABLES.MESSAGES]: slice.map((contact) => ({
                PutRequest: {
                  Item: {
                    PK: `CAMP#${campaignId}`,
                    SK: `MSG#${contact.phone}`,
                    GSI3PK: `CAMP#${campaignId}#STATUS#skipped`,
                    GSI3SK: `MSG#${contact.phone}`,
                    GSI4PK: `PHONE#${(contact.phone || "").replace(/\D/g, "")}`,
                    GSI4SK: now,
                    phoneNumber: contact.phone,
                    contactName: contact.name || "",
                    sendingNumberId: phoneNumberId,
                    metaMessageId: "",
                    status: "skipped",
                    repliedAt: null,
                    errorCode: "campaign_cancelled",
                    sentAt: now,
                    updatedAt: now,
                    csvRow: sanitizeCsvRow(contact),
                  },
                },
              })),
            },
          })
        );
      }
      // Same counter accounting the successful-send/failed paths already do —
      // without this, the campaign's top-level "Skipped" stat stays at 0
      // forever even though the drill-down list (a live message-row query)
      // correctly shows every one of them.
      await addCounters(campaignId, { skippedCount: contacts.length });
      continue;
    }

    // ── CHECKPOINT: Write all contacts as "queued" before doing anything ──
    // This guarantees every contact has a record even if the Lambda crashes
    // mid-batch. The resume handler uses "queued" records to detect stuck work.
    // Skip on resume jobs — records already exist from the original run.
    if (!isResume) {
      const now = new Date().toISOString();
      const DYNAMO_BATCH = 25; // DynamoDB BatchWrite max is 25
      for (let i = 0; i < contacts.length; i += DYNAMO_BATCH) {
        const slice = contacts.slice(i, i + DYNAMO_BATCH);
        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [TABLES.MESSAGES]: slice.map((contact) => ({
                PutRequest: {
                  Item: {
                    PK: `CAMP#${campaignId}`,
                    SK: `MSG#${contact.phone}`,
                    phoneNumber: contact.phone,
                    contactName: contact.name || "",
                    sendingNumberId: phoneNumberId,
                    metaMessageId: "",
                    status: "queued",
                    repliedAt: null,
                    errorCode: null,
                    sentAt: now,
                    updatedAt: now,
                    csvRow: sanitizeCsvRow(contact),
                  },
                },
              })),
            },
          })
        );
      }
      console.log(`Checkpoint: wrote ${contacts.length} queued records for campaign ${campaignId}`);
    }

    // Get template name for this number (may be mapped) — resolved up front
    // so both the category check below and the actual send use the SAME
    // template, instead of checking templateName's category but sending
    // tplName (a real divergence whenever templateMappings overrides a
    // number's template).
    const tplName = templateMappings?.[phoneNumberId] || templateName;

    // Check template category from Meta, and capture its real approved
    // language while we're at it — Meta's message API needs the template
    // name + language to match EXACTLY (e.g. "en_US", not just "en"), and
    // that's not necessarily the same for every template, so a hardcoded
    // language here previously caused every send for a non-"en" template to
    // fail with error 132001 ("Template name does not exist in the
    // translation"). Reuses this same lookup instead of a second Meta call.
    let templateLanguage: string | undefined;
    if (wabaid && accessToken) {
      try {
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${wabaid}/message_templates?name=${encodeURIComponent(tplName)}&limit=25`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const data = (await res.json()) as { data?: { name: string; category: string; language?: string }[] };
        // Meta's ?name= filter matches by PREFIX, not exactly — asking for
        // "ms_9am" happily returns "ms_9am_gj" too. Trusting data[0] meant
        // this could read a DIFFERENT template's category (aborting a healthy
        // campaign, or worse, letting a real MARKETING template through) and
        // its language (a wrong language fails every send with 132001).
        const match = (data.data || []).find((t) => t.name === tplName);
        templateLanguage = match?.language;
        if (match?.category === "MARKETING") {
          console.error(`STOPPED: Template "${tplName}" is MARKETING on ${phoneNumberId}. Skipping batch.`);
          // Create notification
          await createNotification({
            type: "template_marketing",
            businessId: campCheck.Item?.businessId || "",
            businessName: campCheck.Item?.businessName || "",
            phoneNumberId,
            phoneDisplayName: batch.displayName || phoneNumberId,
            templateName: tplName,
            errorMessage: `Template "${tplName}" moved to MARKETING category. Campaign aborted.`,
            campaignId,
          });
          // Update campaign status
          await docClient.send(
            new UpdateCommand({
              TableName: TABLES.CAMPAIGNS,
              Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
              UpdateExpression: "SET #status = :status, updatedAt = :now",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":status": "failed", ":now": new Date().toISOString() },
            })
          );
          return; // Don't process this batch
        }
      } catch (err) {
        console.warn("Category check failed, proceeding:", err);
      }
    }

    // ── RATE LIMITING ──────────────────────────────────────────────────────
    // Meta quality score is driven by user blocks/reports, not just API rate.
    // Key insight: keep each number's send volume low per campaign by using
    // more numbers. With 20 numbers × 250 contacts at 90/min = ~2.8 min total.
    //
    // MSGS_PER_SECOND per number:
   //   0.5  = 30/min  — red/recovering number
    //   0.67 = 40/min  — yellow, being cautious
    //   1.0  = 60/min  — green, normal
    //   1.5  = 90/min  — green, time-sensitive campaigns (prior default)
    //   2.0  = 120/min — green, well-established, short lists only
    //   5.0  = 300/min — green, current default — real campaign data showed
    //          numbers only start hitting Meta's own rate-limit errors around
    //          7-18/sec, so 5/sec leaves real headroom below that ceiling.
    const MSGS_PER_SECOND = parseFloat(process.env.MSGS_PER_SECOND || "5");
    const PARALLEL_BATCH_SIZE = 10;
    const DELAY_BETWEEN_BATCHES_MS = Math.round((PARALLEL_BATCH_SIZE / MSGS_PER_SECOND) * 1000);

    const UNSUBSCRIBE_TABLE = process.env.UNSUBSCRIBE_TABLE || `autoreach-unsubscribe-${process.env.ENV_NAME || "hardik"}`;
    const MASTERCLASS_TABLE = process.env.MASTERCLASS_TABLE || "masterclass_lookup_key";

    // sent/failed/skippedCount used to get their own ADD ...:one UpdateItem call
    // per contact — with GSI1/GSI2 on this table using ALL projection, every one
    // of those single-attribute bumps also rewrote the full item into both GSIs,
    // tripling the write cost of something that's purely a dashboard display
    // number (campaign completion/retry/resume all key off completedBatches or
    // live Message-table queries, never these cached counts — see below).
    // Accumulating locally and flushing once per PARALLEL_BATCH_SIZE chunk cuts
    // that by ~10x with the same final totals; sendSingleMessage's increments are
    // synchronous so concurrent Promise.all calls can't race each other on them.
    const counters = { sent: 0, failed: 0, skipped: 0 };
    async function flushCounters() {
      if (!counters.sent && !counters.failed && !counters.skipped) return;
      // Only reset the local counters once the write actually lands — if this
      // throws (even after retries), the accumulated deltas stay put and ride
      // along into the NEXT flush instead of being silently lost.
      await withThrottleRetry(() =>
        addCounters(campaignId, {
          sentCount: counters.sent,
          failedCount: counters.failed,
          skippedCount: counters.skipped,
        })
      );
      counters.sent = 0;
      counters.failed = 0;
      counters.skipped = 0;
    }

    for (let i = 0; i < contacts.length; i += PARALLEL_BATCH_SIZE) {
      const batchSlice = contacts.slice(i, i + PARALLEL_BATCH_SIZE);
      await Promise.all(batchSlice.map((contact) => sendSingleMessage(contact)));
      // Never let a still-throttled flush (retries exhausted) crash the whole
      // invocation — that would abandon every contact still left in this
      // batch instead of just delaying their counter accounting to the next
      // flush. sendSingleMessage's own PutCommands (the actual message
      // records) are unaffected either way.
      try {
        await flushCounters();
      } catch (err) {
        console.error(`Counter flush failed for campaign ${campaignId}, will retry on next flush:`, err);
      }
      // Pace the sending — wait between groups to avoid quality score drops
      if (i + PARALLEL_BATCH_SIZE < contacts.length) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
      }
    }

    async function sendSingleMessage(contact: CSVContact) {
      try {
        // Check unsubscribe list — campaign-level opt-out, see respectUnsubscribeList
        const phone = (contact.phone || "").replace(/\D/g, "");
        const unsubResult = shouldRespectUnsubscribeList
          ? await docClient.send(new GetCommand({ TableName: UNSUBSCRIBE_TABLE, Key: { PK: `PHONE#${phone}` } }))
          : null;
        if (unsubResult?.Item) {
          // Skip - user unsubscribed
          await docClient.send(
            new PutCommand({
              TableName: TABLES.MESSAGES,
              Item: {
                PK: `CAMP#${campaignId}`,
                SK: `MSG#${contact.phone}`,
                GSI3PK: `CAMP#${campaignId}#STATUS#skipped`,
                GSI3SK: `MSG#${contact.phone}`,
                phoneNumber: contact.phone,
                contactName: contact.name || "",
                sendingNumberId: phoneNumberId,
                metaMessageId: "",
                status: "skipped",
                repliedAt: null,
                errorCode: "unsubscribed",
                sentAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                csvRow: sanitizeCsvRow(contact),
              },
            })
          );
          counters.skipped++;
          return; // Skip — user unsubscribed
        }

        // Check paid-users list — campaign-level opt-out, see excludePaidUsers.
        // Table's real partition key is "pk" with values "PHONE#<phone>" /
        // "EMAIL#<email>" (see nightly-scheduler.ts's checkMasterclass, which
        // had been using the wrong attribute name entirely).
        if (shouldExcludePaidUsers) {
          const email = (contact.email || "").trim().toLowerCase();
          const paidResult = await docClient.send(
            new GetCommand({ TableName: MASTERCLASS_TABLE, Key: { pk: `PHONE#${phone}` } })
          );
          const paidByEmail = !paidResult.Item && email
            ? await docClient.send(new GetCommand({ TableName: MASTERCLASS_TABLE, Key: { pk: `EMAIL#${email}` } }))
            : null;
          if (paidResult.Item || paidByEmail?.Item) {
            await docClient.send(
              new PutCommand({
                TableName: TABLES.MESSAGES,
                Item: {
                  PK: `CAMP#${campaignId}`,
                  SK: `MSG#${contact.phone}`,
                  GSI3PK: `CAMP#${campaignId}#STATUS#skipped`,
                  GSI3SK: `MSG#${contact.phone}`,
                  phoneNumber: contact.phone,
                  contactName: contact.name || "",
                  sendingNumberId: phoneNumberId,
                  metaMessageId: "",
                  status: "skipped",
                  repliedAt: null,
                  errorCode: "already_paid",
                  sentAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  csvRow: sanitizeCsvRow(contact),
                },
              })
            );
            counters.skipped++;
            return; // Skip — already a paid customer
          }
        }

        // Build parameters
        const parameters = Object.entries(parameterMapping as Record<string, string>)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, csvHeaderOrStatic]) => {
            if (csvHeaderOrStatic.startsWith("__STATIC__")) {
              return { type: "text", text: csvHeaderOrStatic.replace("__STATIC__", "") };
            }
            return { type: "text", text: contact[csvHeaderOrStatic] || "" };
          });

        // Non-Meta providers (AiSensy/WATI): dispatch via provider module, skip Meta component/fetch logic below.
        if (provider && provider !== "meta") {
          const providerImpl = getProvider(provider);
          const number: PhoneNumber = { phoneNumberId, displayNumber: "", displayName: batch.displayName || "", apiKey, source, endpoint };
          const result = providerImpl
            ? await providerImpl.sendMessage({
                phone: contact.phone,
                contactName: contact.name || "",
                templateName: tplName,
                parameters: parameters.map((p) => p.text),
                number,
              })
            : { ok: false, error: `Unknown provider "${provider}"` };

          await docClient.send(
            new PutCommand({
              TableName: TABLES.MESSAGES,
              Item: {
                PK: `CAMP#${campaignId}`,
                SK: `MSG#${contact.phone}`,
                GSI3PK: `CAMP#${campaignId}#STATUS#${result.ok ? "sent" : "failed"}`,
                GSI3SK: `MSG#${contact.phone}`,
                GSI4PK: `PHONE#${(contact.phone || "").replace(/\D/g, "")}`,
                GSI4SK: new Date().toISOString(),
                phoneNumber: contact.phone,
                contactName: contact.name || "",
                sendingNumberId: phoneNumberId,
                metaMessageId: result.messageId || "",
                status: result.ok ? "sent" : "failed",
                repliedAt: null,
                errorCode: result.ok ? null : result.error || "Unknown",
                sentAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                csvRow: sanitizeCsvRow(contact),
              },
            })
          );
          if (result.ok) counters.sent++; else counters.failed++;
          if (!result.ok) {
            console.error(`${provider} send failed for ${contact.phone}:`, result.error);
          }
          return;
        }

        // Build components
        const components: unknown[] = [];

        // Header image (only for numbers that need it)
        if (headerImageUrl && numbersWithImageHeader?.includes(phoneNumberId)) {
          components.push({
            type: "header",
            parameters: [{ type: "image", image: { link: headerImageUrl } }],
          });
        }

        // Body parameters
        if (parameters.length > 0) {
          components.push({ type: "body", parameters });
        }

        // Send via Meta API
        const response = await fetch(
          `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: contact.phone,
              type: "template",
              template: {
                name: tplName,
                language: { code: templateLanguage || "en_US" },
                components,
              },
            }),
          }
        );

        const data = (await response.json()) as { messages?: { id: string }[]; error?: { message: string; code?: number } };

        if (response.ok && data.messages?.[0]) {
          // Store success — GSI3PK enables query by campaign+status
          await docClient.send(
            new PutCommand({
              TableName: TABLES.MESSAGES,
              Item: {
                PK: `CAMP#${campaignId}`,
                SK: `MSG#${contact.phone}`,
                GSI1PK: `METAMSG#${data.messages[0].id}`,
                GSI1SK: `CAMP#${campaignId}`,
                GSI3PK: `CAMP#${campaignId}#STATUS#sent`,
                GSI3SK: `MSG#${contact.phone}`,
                GSI4PK: `PHONE#${(contact.phone || "").replace(/\D/g, "")}`,
                GSI4SK: new Date().toISOString(),
                phoneNumber: contact.phone,
                contactName: contact.name || "",
                sendingNumberId: phoneNumberId,
                metaMessageId: data.messages[0].id,
                status: "sent",
                repliedAt: null,
                errorCode: null,
                sentAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                csvRow: sanitizeCsvRow(contact),
              },
            })
          );
          counters.sent++;
        } else {
          // Store failure. Prefer Meta's numeric error code (same convention the
          // async delivery-failure webhook uses in webhook-worker.ts) so retry-failed.ts
          // can classify it correctly — falling back to the message text only when
          // Meta didn't give a code.
          const errMsg = data.error?.message || "Unknown";
          const storedErrorCode = data.error?.code != null ? String(data.error.code) : errMsg;
          await docClient.send(
            new PutCommand({
              TableName: TABLES.MESSAGES,
              Item: {
                PK: `CAMP#${campaignId}`,
                SK: `MSG#${contact.phone}`,
                GSI3PK: `CAMP#${campaignId}#STATUS#failed`,
                GSI3SK: `MSG#${contact.phone}`,
                GSI4PK: `PHONE#${(contact.phone || "").replace(/\D/g, "")}`,
                GSI4SK: new Date().toISOString(),
                phoneNumber: contact.phone,
                contactName: contact.name || "",
                sendingNumberId: phoneNumberId,
                metaMessageId: "",
                status: "failed",
                repliedAt: null,
                errorCode: storedErrorCode,
                sentAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                csvRow: sanitizeCsvRow(contact),
              },
            })
          );
          counters.failed++;
          // Permanent, customer-side failure (not on WhatsApp / old WhatsApp
          // version) — stop every future campaign from re-sending to this
          // number instead of only this one failing silently again next time.
          await addToStopListIfPermanentRecipientError(contact.phone, storedErrorCode);
          // Notify on critical errors (payment, parameter, rate limit)
          if (errMsg.includes("payment") || errMsg.includes("param") || errMsg.includes("rate") || errMsg.includes("spam") || errMsg.includes("blocked")) {
            await createNotification({
              type: "send_failed",
              businessId: campCheck.Item?.businessId || "",
              businessName: campCheck.Item?.businessName || "",
              phoneNumberId,
              phoneDisplayName: batch.displayName || phoneNumberId,
              templateName: tplName,
              errorMessage: errMsg,
              campaignId,
            });
          }
        }
      } catch (err) {
        console.error(`Failed to send to ${contact.phone}:`, err);
      }
    }

    console.log(`Worker completed: ${contacts.length} messages processed for ${phoneNumberId}`);

    // Atomically mark this batch done. ALL_NEW returns both the just-incremented
    // completedBatches AND the current totalBatches (which resume.ts/retry-failed.ts
    // may have grown since send.ts first set it) in one consistent read — so exactly
    // one invocation will ever see completedBatches reach totalBatches, guaranteed by
    // DynamoDB's atomicity rather than by hoping concurrent reads don't race each
    // other (the old totalRecords-based check could be — and was — silently skipped
    // by every invocation if none of their independent reads happened to land on the
    // exact final state).
    try {
      // This is the one write that MUST land — a dropped completedBatches
      // ADD (confirmed in production: 21 ThrottlingExceptions, after the AWS
      // SDK's own 3 retry attempts, permanently stranded a 26k-contact
      // campaign at 139/160 forever, since nothing else ever re-attempts it)
      // strands the whole campaign at "running": no auto-complete, no
      // auto-retry, no resume trigger, since all three key off this counter
      // reaching totalBatches.
      const counterResult = await withThrottleRetry(() =>
        docClient.send(new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "ADD completedBatches :one",
          ExpressionAttributeValues: { ":one": 1 },
          ReturnValues: "ALL_NEW",
        }))
      );
      const camp = counterResult.Attributes;
      if (!camp || camp.status !== "running") return;

      const totalBatches = camp.totalBatches as number | undefined;
      const completedBatches = camp.completedBatches as number;
      if (totalBatches == null || completedBatches < totalBatches) {
        console.log(`Campaign ${campaignId}: ${completedBatches}/${totalBatches ?? "?"} batches done`);
        return;
      }

      const { QueryCommand: QCmd } = await import("@aws-sdk/lib-dynamodb");

      // Check if any are still stuck in "queued" (worker crashed mid-batch)
      const queuedResult = await docClient.send(
        new QCmd({
          TableName: TABLES.MESSAGES,
          KeyConditionExpression: "PK = :pk",
          FilterExpression: "#s = :queued",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":queued": "queued" },
          Select: "COUNT",
        })
      );
      const queuedCount = queuedResult.Count || 0;

      if (queuedCount > 0) {
        // Some workers crashed — trigger resume to re-process stuck contacts
        console.log(`Resume needed: ${queuedCount} contacts still queued in campaign ${campaignId}`);
        const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
        const lambda = new LambdaClient({});
        await lambda.send(new InvokeCommand({
          FunctionName: process.env.RESUME_FUNCTION_NAME || "",
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ campaignId })),
        }));
        return;
      }

      // All contacts processed — check for failed ones
      const failedResult = await docClient.send(
        new QCmd({
          TableName: TABLES.MESSAGES,
          KeyConditionExpression: "PK = :pk",
          FilterExpression: "#s = :failed",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":failed": "failed" },
          Select: "COUNT",
        })
      );
      const failedCount = failedResult.Count || 0;

      if (camp.autoRetry && failedCount > 0 && (camp.retryCount || 0) === 0) {
        console.log(`Auto-retry: ${failedCount} failed in campaign ${campaignId}`);
        const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
        const lambda = new LambdaClient({});
        await lambda.send(new InvokeCommand({
          FunctionName: process.env.RETRY_FUNCTION_NAME || "",
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ httpMethod: "POST", pathParameters: { campaignId }, headers: {}, body: "{}" })),
        }));
        await docClient.send(new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "SET retryCount = :rc, updatedAt = :now",
          ExpressionAttributeValues: { ":rc": 1, ":now": new Date().toISOString() },
        }));
      } else {
        await docClient.send(new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now, completedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": "completed", ":gsi2pk": "STATUS#completed", ":now": new Date().toISOString() },
        }));
        console.log(`Campaign ${campaignId} completed`);
        await createRetryFailedCampaignIfNeeded(campaignId);
      }
    } catch (err) {
      // Previously just console.warn'd and silently left the campaign stuck at
      // "running" forever with no auto-retry — now at least surfaced as a real
      // notification so someone can manually resume/retry it.
      console.error(`Campaign completion check failed for ${campaignId}:`, err);
      try {
        await createNotification({
          type: "campaign_stuck",
          businessId: campCheck.Item?.businessId || "",
          businessName: campCheck.Item?.businessName || "",
          phoneNumberId: "",
          phoneDisplayName: "",
          errorMessage: `Completion check failed: ${err instanceof Error ? err.message : String(err)}. Campaign may be stuck at "running" — check manually.`,
          campaignId,
        });
      } catch {
        // don't let a notification failure mask the original error
      }
    }
  }
};
