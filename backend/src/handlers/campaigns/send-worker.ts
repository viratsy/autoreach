import { SQSHandler } from "aws-lambda";
import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { CSVContact } from "../../lib/types";
import { createNotification } from "../notifications/index";

/**
 * Worker: Processes a batch of ~200 contacts from SQS.
 * 1. Checks template category every batch (from local DB)
 * 2. Sends messages via Meta API
 * 3. Stores message records in DynamoDB
 */
export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const {
      campaignId,
      templateName,
      templateMappings,
      parameterMapping,
      headerImageUrl,
      numbersWithImageHeader,
      accessToken,
      batch,
    } = JSON.parse(record.body);

    const { contacts, phoneNumberId, wabaid } = batch as {
      contacts: CSVContact[];
      phoneNumberId: string;
      displayName: string;
      wabaid?: string;
    };

    console.log(`Worker: ${contacts.length} contacts for ${phoneNumberId} in campaign ${campaignId}`);

    // Check template category from local DB (updated by webhook)
    const templateRecord = await docClient.send(
      new GetCommand({
        TableName: TABLES.TEMPLATES,
        Key: { PK: `BIZ#${campaignId.split("_")[0]}`, SK: `TPL#${phoneNumberId}#${templateName}` },
      })
    );

    // Also check via Meta API for this batch (safety)
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

    // Send messages
    const UNSUBSCRIBE_TABLE = process.env.UNSUBSCRIBE_TABLE || "autoreach-unsubscribe-hardik";

    for (const contact of contacts) {
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
          continue;
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
          // Store success
          await docClient.send(
            new PutCommand({
              TableName: TABLES.MESSAGES,
              Item: {
                PK: `CAMP#${campaignId}`,
                SK: `MSG#${contact.phone}`,
                GSI1PK: `METAMSG#${data.messages[0].id}`,
                GSI1SK: `CAMP#${campaignId}`,
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
        } else {
          // Store failure
          const errMsg = data.error?.message || "Unknown";
          await docClient.send(
            new PutCommand({
              TableName: TABLES.MESSAGES,
              Item: {
                PK: `CAMP#${campaignId}`,
                SK: `MSG#${contact.phone}`,
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
    try {
      const campResult = await docClient.send(
        new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
      );
      const camp = campResult.Item;
      if (camp && camp.status === "running") {
        const { QueryCommand: QCmd } = await import("@aws-sdk/lib-dynamodb");
        const msgCount = await docClient.send(
          new QCmd({
            TableName: TABLES.MESSAGES,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}` },
            Select: "COUNT",
          })
        );
        if ((msgCount.Count || 0) >= camp.totalContacts) {
          // Check for failed messages
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
            // Invoke retry function asynchronously
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
        }
      }
    } catch (err) {
      console.warn("Status check:", err);
    }
  }
};
