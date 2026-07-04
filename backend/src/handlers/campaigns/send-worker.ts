import { SQSHandler } from "aws-lambda";
import { PutCommand, GetCommand, UpdateCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { CSVContact, PhoneNumber } from "../../lib/types";
import { createNotification } from "../notifications/index";
import { getProvider } from "../../lib/providers";

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
      accessToken,
      batch,
      isResume,
    } = JSON.parse(record.body);

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
                  },
                },
              })),
            },
          })
        );
      }
      console.log(`Checkpoint: wrote ${contacts.length} queued records for campaign ${campaignId}`);
    }

    // Check template category from local DB (updated by webhook)
    if (wabaid && accessToken) {
      try {
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${wabaid}/message_templates?name=${templateName}&limit=1`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const data = (await res.json()) as { data?: { category: string }[] };
        if (data.data?.[0]?.category === "MARKETING") {
          console.error(`STOPPED: Template "${templateName}" is MARKETING on ${phoneNumberId}. Skipping batch.`);
          // Create notification
          await createNotification({
            type: "template_marketing",
            businessId: campaignId.split("_")[0] || "",
            businessName: batch.displayName || "",
            phoneNumberId,
            phoneDisplayName: batch.displayName || phoneNumberId,
            templateName,
            errorMessage: `Template "${templateName}" moved to MARKETING category. Campaign aborted.`,
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

    // Get template name for this number (may be mapped)
    const tplName = templateMappings?.[phoneNumberId] || templateName;

    // ── RATE LIMITING ──────────────────────────────────────────────────────
    // Meta quality score is driven by user blocks/reports, not just API rate.
    // Key insight: keep each number's send volume low per campaign by using
    // more numbers. With 20 numbers × 250 contacts at 90/min = ~2.8 min total.
    //
    // MSGS_PER_SECOND per number:
   //   0.5  = 30/min  — red/recovering number 
    //   0.67 = 40/min  — yellow, being cautious
    //   1.0  = 60/min  — green, normal
    //   1.5  = 90/min  — green, time-sensitive campaigns (default)
    //   2.0  = 120/min — green, well-established, short lists only
    const MSGS_PER_SECOND = parseFloat(process.env.MSGS_PER_SECOND || "1.5");
    const PARALLEL_BATCH_SIZE = 10;
    const DELAY_BETWEEN_BATCHES_MS = Math.round((PARALLEL_BATCH_SIZE / MSGS_PER_SECOND) * 1000);

    const UNSUBSCRIBE_TABLE = process.env.UNSUBSCRIBE_TABLE || `autoreach-unsubscribe-${process.env.ENV_NAME || "hardik"}`;

    for (let i = 0; i < contacts.length; i += PARALLEL_BATCH_SIZE) {
      const batchSlice = contacts.slice(i, i + PARALLEL_BATCH_SIZE);
      await Promise.all(batchSlice.map((contact) => sendSingleMessage(contact)));
      // Pace the sending — wait between groups to avoid quality score drops
      if (i + PARALLEL_BATCH_SIZE < contacts.length) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
      }
    }

    async function sendSingleMessage(contact: CSVContact) {
      try {
        // Check unsubscribe list
        const phone = (contact.phone || "").replace(/\D/g, "");
        const unsubResult = await docClient.send(
          new GetCommand({ TableName: UNSUBSCRIBE_TABLE, Key: { PK: `PHONE#${phone}` } })
        );
        if (unsubResult.Item) {
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
              },
            })
          );
          return; // Skip — user unsubscribed
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
                phoneNumber: contact.phone,
                contactName: contact.name || "",
                sendingNumberId: phoneNumberId,
                metaMessageId: result.messageId || "",
                status: result.ok ? "sent" : "failed",
                repliedAt: null,
                errorCode: result.ok ? null : result.error || "Unknown",
                sentAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            })
          );
          await docClient.send(new UpdateCommand({
            TableName: TABLES.CAMPAIGNS,
            Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
            UpdateExpression: `ADD ${result.ok ? "sentCount" : "failedCount"} :one SET updatedAt = :now`,
            ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
          }));
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
                language: { code: "en" },
                components,
              },
            }),
          }
        );

        const data = (await response.json()) as { messages?: { id: string }[]; error?: { message: string } };

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
                phoneNumber: contact.phone,
                contactName: contact.name || "",
                sendingNumberId: phoneNumberId,
                metaMessageId: data.messages[0].id,
                status: "sent",
                repliedAt: null,
                errorCode: null,
                sentAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            })
          );
          // Increment sentCount on campaign
          await docClient.send(new UpdateCommand({
            TableName: TABLES.CAMPAIGNS,
            Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
            UpdateExpression: "ADD sentCount :one SET updatedAt = :now",
            ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
          }));
        } else {
          // Store failure
          const errMsg = data.error?.message || "Unknown";
          await docClient.send(
            new PutCommand({
              TableName: TABLES.MESSAGES,
              Item: {
                PK: `CAMP#${campaignId}`,
                SK: `MSG#${contact.phone}`,
                GSI3PK: `CAMP#${campaignId}#STATUS#failed`,
                GSI3SK: `MSG#${contact.phone}`,
                phoneNumber: contact.phone,
                contactName: contact.name || "",
                sendingNumberId: phoneNumberId,
                metaMessageId: "",
                status: "failed",
                repliedAt: null,
                errorCode: errMsg,
                sentAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            })
          );
          // Increment failedCount on campaign
          await docClient.send(new UpdateCommand({
            TableName: TABLES.CAMPAIGNS,
            Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
            UpdateExpression: "ADD failedCount :one SET updatedAt = :now",
            ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
          }));
          // Notify on critical errors (payment, parameter, rate limit)
          if (errMsg.includes("payment") || errMsg.includes("param") || errMsg.includes("rate") || errMsg.includes("spam") || errMsg.includes("blocked")) {
            await createNotification({
              type: "send_failed",
              businessId: campaignId.split("_")[0] || "",
              businessName: batch.displayName || "",
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

    // Check if all messages for this campaign are done
    // "done" = no contacts left in "queued" state (all have been sent/failed/skipped)
    try {
      const campResult = await docClient.send(
        new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
      );
      const camp = campResult.Item;
      if (camp && camp.status === "running") {
        const { QueryCommand: QCmd } = await import("@aws-sdk/lib-dynamodb");

        // Count total message records written so far
        const msgCount = await docClient.send(
          new QCmd({
            TableName: TABLES.MESSAGES,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}` },
            Select: "COUNT",
          })
        );
        const totalRecords = msgCount.Count || 0;

        // Only proceed to completion check once all contacts have a record
        if (totalRecords >= camp.totalContacts) {
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
              UpdateExpression: "SET #status = :status, GSI2PK = :gsi2pk, updatedAt = :now",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":status": "completed", ":gsi2pk": "STATUS#completed", ":now": new Date().toISOString() },
            }));
            console.log(`Campaign ${campaignId} completed`);
          }
        } else {
          console.log(`Campaign ${campaignId}: ${totalRecords}/${camp.totalContacts} records written, still processing`);
        }
      }
    } catch (err) {
      console.warn("Status check:", err);
    }
  }
};
