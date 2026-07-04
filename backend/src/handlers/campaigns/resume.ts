import { Handler } from "aws-lambda";
import { QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { docClient, TABLES } from "../../lib/dynamo";

const sqs = new SQSClient({});
const SEND_QUEUE_URL = process.env.SEND_QUEUE_URL || "";
const BATCH_SIZE = 200;

/**
 * Resume handler: finds all contacts stuck in "queued" state for a campaign
 * and re-queues them for sending. Called automatically when a worker detects
 * queued contacts remain after all records are written (i.e. a worker crashed).
 *
 * Also exposed as POST /campaigns/{campaignId}/resume for manual recovery.
 *
 * This is what saves a 2-lakh list if Lambda workers drop mid-batch.
 */
export const handler: Handler = async (event) => {
  try {
    // Accept both direct invocation { campaignId } and API Gateway
    const campaignId =
      event.campaignId ||
      event.pathParameters?.campaignId ||
      JSON.parse(event.body || "{}").campaignId;

    if (!campaignId) {
      console.error("No campaignId provided");
      return { statusCode: 400, body: JSON.stringify({ error: "campaignId required" }) };
    }

    console.log(`Resume: checking stuck contacts for campaign ${campaignId}`);

    // Get campaign
    const campResult = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = campResult.Item;
    if (!campaign) {
      return { statusCode: 404, body: JSON.stringify({ error: "Campaign not found" }) };
    }

    // Get business access token
    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${campaign.businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) {
      return { statusCode: 500, body: JSON.stringify({ error: "Business not found" }) };
    }
    const accessToken = business.accessToken;

    // Fetch all contacts still in "queued" state
    // Use pagination — campaigns can have 200k+ contacts
    const stuckContacts: { phone: string; name: string; sendingNumberId: string }[] = [];
    let lastKey: Record<string, unknown> | undefined = undefined;

    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLES.MESSAGES,
          KeyConditionExpression: "PK = :pk",
          FilterExpression: "#s = :queued",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":queued": "queued" },
          ExclusiveStartKey: lastKey,
        })
      );
      for (const item of result.Items || []) {
        stuckContacts.push({
          phone: item.phoneNumber,
          name: item.contactName || "",
          sendingNumberId: item.sendingNumberId,
        });
      }
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    console.log(`Resume: found ${stuckContacts.length} stuck contacts for campaign ${campaignId}`);

    if (stuckContacts.length === 0) {
      // Nothing stuck — campaign might genuinely be done, trigger completion check
      await checkAndCompletecamp(campaignId, campaign);
      return { statusCode: 200, body: JSON.stringify({ message: "No stuck contacts", resumed: 0 }) };
    }

    // Group by sending number (preserve original assignment)
    const byNumber: Record<string, { phone: string; name: string }[]> = {};
    for (const contact of stuckContacts) {
      if (!byNumber[contact.sendingNumberId]) byNumber[contact.sendingNumberId] = [];
      byNumber[contact.sendingNumberId].push({ phone: contact.phone, name: contact.name });
    }

    // Find the number metadata from campaign
    const numberMeta: Record<string, { displayName: string; wabaid?: string }> = {};
    for (const num of (campaign.selectedNumbers || [])) {
      numberMeta[num.phoneNumberId] = { displayName: num.displayName || "", wabaid: num.wabaid };
    }

    // Re-queue in batches of BATCH_SIZE
    let totalQueued = 0;
    for (const [phoneNumberId, contacts] of Object.entries(byNumber)) {
      const meta = numberMeta[phoneNumberId] || { displayName: "", wabaid: undefined };

      for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
        const slice = contacts.slice(i, i + BATCH_SIZE);
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: SEND_QUEUE_URL,
            MessageBody: JSON.stringify({
              campaignId,
              templateName: campaign.templateName,
              templateMappings: campaign.templateMappings || {},
              parameterMapping: campaign.parameterMapping || {},
              headerImageUrl: campaign.headerImageUrl || "",
              numbersWithImageHeader: campaign.numbersWithImageHeader || [],
              accessToken,
              isResume: true, // tells worker to skip checkpoint write (records already exist)
              batch: {
                contacts: slice,
                phoneNumberId,
                displayName: meta.displayName,
                wabaid: meta.wabaid,
              },
            }),
          })
        );
        totalQueued += slice.length;
      }
    }

    console.log(`Resume: re-queued ${totalQueued} contacts across ${Object.keys(byNumber).length} numbers`);

    // Mark campaign as running again if it somehow got stuck in another state
    if (campaign.status !== "running") {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "SET #status = :s, GSI2PK = :gsi, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":s": "running",
            ":gsi": "STATUS#running",
            ":now": new Date().toISOString(),
          },
        })
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Resumed", resumed: totalQueued, numbers: Object.keys(byNumber).length }),
    };
  } catch (err) {
    console.error("Resume error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Resume failed" }) };
  }
};

async function checkAndCompletecamp(campaignId: string, campaign: Record<string, unknown>) {
  const { QueryCommand: QCmd } = await import("@aws-sdk/lib-dynamodb");
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
  const autoRetry = campaign.autoRetry as boolean | undefined;
  const retryCount = (campaign.retryCount as number | undefined) || 0;

  if (autoRetry && failedCount > 0 && retryCount === 0) {
    const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
    const lambda = new LambdaClient({});
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.RETRY_FUNCTION_NAME || "",
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ httpMethod: "POST", pathParameters: { campaignId }, headers: {}, body: "{}" })),
    }));
  } else {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
        UpdateExpression: "SET #status = :s, GSI2PK = :gsi, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":s": "completed",
          ":gsi": "STATUS#completed",
          ":now": new Date().toISOString(),
        },
      })
    );
    console.log(`Campaign ${campaignId} marked completed`);
  }
}
