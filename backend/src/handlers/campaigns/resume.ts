import { Handler } from "aws-lambda";
import { QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { docClient, TABLES } from "../../lib/dynamo";
import { getAuthEmail } from "../../lib/auth";
import { createNotification } from "../notifications/index";

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

    // A real API Gateway call always populates requestContext; the internal
    // Lambda-to-Lambda invokes from send-worker.ts (worker-crash recovery) send a
    // bare {campaignId} with no requestContext at all — trust IAM for those and
    // only require a JWT when this came in over HTTP.
    if (event.requestContext) {
      if (!getAuthEmail(event)) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
      }
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

    // Refuse to revive a campaign a human explicitly cancelled (or one already
    // completed). The legitimate worker-crash auto-recovery path only ever fires
    // while send-worker.ts still sees status "running", so this adds no new
    // restriction there — it only blocks POST /resume from resurrecting a
    // cancelled/completed campaign.
    if (campaign.status === "cancelled" || campaign.status === "completed") {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: `Campaign is already ${campaign.status}, cannot resume` }),
      };
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
      // "No stuck contacts" can ALSO mean checkpoint writes have been failing
      // outright for this campaign (e.g. every batch crashes before writing
      // anything at all) — not just "everything already progressed past
      // queued." Compare against completedBatches/totalBatches (the same
      // ground truth send-worker.ts's own completion check uses) before
      // concluding the campaign is actually done; otherwise a campaign that
      // never sent a single message can get silently marked "completed".
      const totalBatches = campaign.totalBatches as number | undefined;
      const completedBatches = (campaign.completedBatches as number | undefined) || 0;
      if (totalBatches != null && completedBatches < totalBatches) {
        console.log(
          `Resume: ${completedBatches}/${totalBatches} batches completed for ${campaignId} — ` +
          `not actually done despite no stuck contacts (checkpoint writes may be failing outright)`
        );
        try {
          await createNotification({
            type: "campaign_stuck",
            businessId: (campaign.businessId as string) || "",
            businessName: (campaign.businessName as string) || "",
            phoneNumberId: "",
            phoneDisplayName: "",
            errorMessage:
              `Campaign has 0 stuck contacts but only ${completedBatches}/${totalBatches} batches ever ` +
              `completed — sending may be failing before any message ever gets written. Needs manual review.`,
            campaignId,
          });
        } catch { /* don't let a notification failure mask the underlying issue */ }
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "No stuck contacts, but batches never completed — needs investigation", resumed: 0 }),
        };
      }

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

    // Re-queue in batches of BATCH_SIZE. Same FIFO group/dedup treatment as
    // send.ts, so resumed batches still serialize strictly per number.
    let totalQueued = 0;
    let resumeBatchCount = 0;
    const resumeRunId = Date.now();
    for (const [phoneNumberId, contacts] of Object.entries(byNumber)) {
      const meta = numberMeta[phoneNumberId] || { displayName: "", wabaid: undefined };

      for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
        const slice = contacts.slice(i, i + BATCH_SIZE);
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: SEND_QUEUE_URL,
            MessageGroupId: phoneNumberId,
            MessageDeduplicationId: `resume-${campaignId}-${phoneNumberId}-${i}-${resumeRunId}`,
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
        resumeBatchCount++;
      }
    }

    // These are batches beyond what send.ts originally counted — grow the expected
    // total so send-worker.ts's atomic completedBatches counter can still land on
    // an exact match once every one of these (plus the original set) finishes.
    if (resumeBatchCount > 0) {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "ADD totalBatches :rb",
          ExpressionAttributeValues: { ":rb": resumeBatchCount },
        })
      );
    }

    console.log(`Resume: re-queued ${totalQueued} contacts across ${Object.keys(byNumber).length} numbers`);

    // Mark campaign as running again if it somehow got stuck in another state.
    // Conditioned on not-cancelled so a cancel that lands between our earlier
    // status check and here can't be silently overwritten back to "running".
    if (campaign.status !== "running") {
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: TABLES.CAMPAIGNS,
            Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
            UpdateExpression: "SET #status = :s, GSI2PK = :gsi, updatedAt = :now",
            ConditionExpression: "#status <> :cancelled",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":s": "running",
              ":gsi": "STATUS#running",
              ":now": new Date().toISOString(),
              ":cancelled": "cancelled",
            },
          })
        );
      } catch (err) {
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
          console.log(`Resume: campaign ${campaignId} was cancelled concurrently, not marking running`);
        } else {
          throw err;
        }
      }
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
        UpdateExpression: "SET #status = :s, GSI2PK = :gsi, updatedAt = :now, completedAt = :now",
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
