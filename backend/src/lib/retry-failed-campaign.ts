import { GetCommand, UpdateCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { docClient, TABLES } from "./dynamo";
import { generateCampaignId } from "./campaign-id";
import { filterHealthyNumbers } from "./round-robin";
import { extractKnownErrorCode } from "./error-codes";
import { estimateCost } from "./pricing";
import { parseCSVWithHeaders, stringifyCSV } from "./csv";
import { CampaignRecord, PhoneNumber } from "./types";
import { createNotification } from "../handlers/notifications/index";

const s3 = new S3Client({});
const lambda = new LambdaClient({});

const NOT_ON_WHATSAPP_CODE = "131026";
// Codes that indicate the SENDING NUMBER is the problem (rate-limited, billing,
// policy block, or its template specifically paused/disabled for low quality)
// rather than the contact — a number with one of these should be excluded from
// the follow-up campaign's pool, not just retried on itself again. A number's
// quality rating (checked separately via filterHealthyNumbers) and its per-
// template pause state are independent — a GREEN number can still have this
// campaign's specific template paused, so that has to be checked here too.
const SENDER_SPECIFIC_CODES = new Set(["130429", "131042", "368", "132015", "132016"]);

/**
 * Once a campaign reaches its true final "completed" state (after whatever
 * in-place auto-retry it already did), check what's still failed and — if the
 * campaign opted into failureMode "reroute" — spin up a follow-up campaign
 * ("Retry-Failed-<name>") for everything worth retrying, using only numbers
 * from the original campaign that are both currently healthy AND didn't
 * themselves cause a sender-specific failure here. Sent immediately (mirrors
 * the frontend's "Send Now"), and guarded so this only ever fires once per
 * campaign. Best-effort: any failure here is logged, never thrown, since it
 * runs at the tail of a campaign's own completion and shouldn't be able to
 * affect that campaign's own status.
 */
export async function createRetryFailedCampaignIfNeeded(campaignId: string): Promise<void> {
  try {
    const campResult = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = campResult.Item as CampaignRecord | undefined;
    if (!campaign) return;
    if (campaign.failureMode !== "reroute") return;
    if (campaign.retryFailedCampaignId) return; // already spawned one for this campaign
    if (campaign.parentCampaignId) return; // this IS a retry-follow-up — don't chain another

    // Fetch all failed messages (paginated — a large campaign can have thousands).
    let failedMessages: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLES.MESSAGES,
          KeyConditionExpression: "PK = :pk",
          FilterExpression: "#s = :failed",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":failed": "failed" },
          ExclusiveStartKey: lastKey,
        })
      );
      failedMessages = failedMessages.concat(result.Items || []);
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    if (failedMessages.length === 0) return;

    // Prefer each message's own csvRow (captured at send time — see send-worker.ts)
    // over re-fetching the source CSV: for a 40K-contact campaign with 2000
    // failures, that avoids downloading and parsing all 40K rows just to find
    // 2000. Only messages written before csvRow existed need the CSV fallback.
    const retryRecordsFromMsg: Record<string, string>[] = [];
    const missingCsvRowPhones = new Set<string>();
    const senderSpecificNumbers = new Set<string>();

    for (const msg of failedMessages) {
      const rawCode = (msg.errorCode as string) || "";
      const knownCode = extractKnownErrorCode(rawCode);
      if (knownCode === NOT_ON_WHATSAPP_CODE) continue; // nothing we can do about this — skip for good

      const phone = (msg.phoneNumber as string) || "";
      if (msg.csvRow) {
        retryRecordsFromMsg.push(msg.csvRow as Record<string, string>);
      } else {
        missingCsvRowPhones.add(phone);
      }
      if (knownCode && SENDER_SPECIFIC_CODES.has(knownCode)) {
        senderSpecificNumbers.add(msg.sendingNumberId as string);
      }
    }

    let retryRecords = retryRecordsFromMsg;
    let headers = retryRecordsFromMsg.length > 0 ? Object.keys(retryRecordsFromMsg[0]) : [];

    if (missingCsvRowPhones.size > 0) {
      // Older messages predating the csvRow field — fall back to re-parsing the
      // original CSV, but only pay that cost when it's actually needed, and use
      // its header list (a superset, guaranteed consistent with itself) for
      // everything rather than merging two possibly-different header sets.
      const csvResult = await s3.send(
        new GetObjectCommand({ Bucket: process.env.CSV_BUCKET!, Key: campaign.csvS3Key })
      );
      const csvText = await csvResult.Body!.transformToString();
      const { headers: origHeaders, records } = parseCSVWithHeaders(csvText);
      const fallbackRecords = records.filter((r) => missingCsvRowPhones.has(r.phone));
      retryRecords = [...retryRecords, ...fallbackRecords];
      headers = origHeaders;
    }

    if (retryRecords.length === 0) return; // everything left was "not on WhatsApp" (or unmatched)

    const newCampaignName = `Retry-Failed-${campaign.campaignName}`;
    const newCampaignId = generateCampaignId(newCampaignName);

    // Atomic claim: only the first invocation to reach here for this campaign
    // proceeds. Set eagerly with the real ID (not a placeholder) — if anything
    // below fails, the campaign just won't get a retry follow-up rather than
    // getting a dangling record we'd need to reconcile later.
    const claimed = await docClient
      .send(
        new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
          UpdateExpression: "SET retryFailedCampaignId = :id",
          ConditionExpression: "attribute_not_exists(retryFailedCampaignId)",
          ExpressionAttributeValues: { ":id": newCampaignId },
        })
      )
      .then(() => true)
      .catch((err) => {
        if (err.name === "ConditionalCheckFailedException") return false;
        throw err;
      });
    if (!claimed) return; // another invocation already claimed this campaign

    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${campaign.businessId}`, SK: "METADATA" } })
    );
    const bizNumbersById = new Map(
      ((bizResult.Item?.phoneNumbers || []) as PhoneNumber[]).map((pn) => [pn.phoneNumberId, pn])
    );

    const withQuality = (campaign.selectedNumbers || []).map((n) => ({
      ...n,
      qualityRating: bizNumbersById.get(n.phoneNumberId)?.qualityRating,
      messagingLimit: bizNumbersById.get(n.phoneNumberId)?.messagingLimit,
    }));
    const qualityHealthy = filterHealthyNumbers(withQuality);
    const healthyNumbers = qualityHealthy.filter((n) => !senderSpecificNumbers.has(n.phoneNumberId));

    if (healthyNumbers.length === 0) {
      await createNotification({
        type: "campaign_stuck",
        businessId: campaign.businessId,
        businessName: campaign.businessName,
        phoneNumberId: "",
        phoneDisplayName: "",
        errorMessage: `${retryRecords.length} failed contact(s) in "${campaign.campaignName}" could not be auto-retried — every number used in this campaign is either unhealthy or caused a rate-limit/payment/policy failure here. Manual review needed.`,
        campaignId,
      });
      return;
    }

    // Re-serialize the matching original rows (same headers, so parameterMapping
    // keeps resolving every template parameter exactly as it did originally).
    const newCsvKey = `retry-failed/${campaignId}-${Date.now()}.csv`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.CSV_BUCKET!,
        Key: newCsvKey,
        Body: stringifyCSV(headers, retryRecords),
        ContentType: "text/csv",
      })
    );

    const now = new Date().toISOString();
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const scheduleDate = istNow.toISOString().slice(0, 10);
    const scheduleTime = istNow.toISOString().slice(11, 16);

    const newRecord: CampaignRecord = {
      PK: `CAMP#${newCampaignId}`,
      SK: "METADATA",
      GSI1PK: `BIZ#${campaign.businessId}`,
      GSI1SK: now,
      GSI2PK: "STATUS#scheduled",
      GSI2SK: `${scheduleDate}#${scheduleTime}`,
      campaignId: newCampaignId,
      campaignName: newCampaignName,
      businessId: campaign.businessId,
      businessName: campaign.businessName,
      workshop: campaign.workshop,
      batch: campaign.batch,
      msg: campaign.msg,
      selectedNumbers: healthyNumbers,
      templateName: campaign.templateName,
      templateCategory: campaign.templateCategory,
      templateMappings: campaign.templateMappings,
      parameterMapping: campaign.parameterMapping,
      headerImageUrl: campaign.headerImageUrl,
      numbersWithImageHeader: campaign.numbersWithImageHeader,
      csvS3Key: newCsvKey,
      failureMode: campaign.failureMode,
      autoRetry: campaign.autoRetry ?? true,
      retryCount: 0,
      totalContacts: retryRecords.length,
      scheduleDate,
      scheduleTime,
      estimatedCost: estimateCost(retryRecords.length, campaign.templateCategory || "UTILITY"),
      status: "scheduled",
      createdBy: campaign.createdBy || "system",
      createdAt: now,
      updatedAt: now,
      parentCampaignId: campaignId,
    };

    await docClient.send(new PutCommand({ TableName: TABLES.CAMPAIGNS, Item: newRecord }));

    // "Send Now" — invoke the orchestrator directly instead of waiting on a schedule.
    await lambda.send(
      new InvokeCommand({
        FunctionName: process.env.SEND_CAMPAIGN_FUNCTION_NAME || "",
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ campaignId: newCampaignId })),
      })
    );

    await createNotification({
      type: "retry_campaign_created",
      businessId: campaign.businessId,
      businessName: campaign.businessName,
      phoneNumberId: "",
      phoneDisplayName: "",
      errorMessage: `Created "${newCampaignName}" with ${retryRecords.length} contact(s), sending now from ${healthyNumbers.length} healthy number(s).${
        senderSpecificNumbers.size > 0
          ? ` Excluded ${senderSpecificNumbers.size} number(s) that had rate-limit/payment/policy failures in the original campaign.`
          : ""
      }`,
      campaignId: newCampaignId,
    });
  } catch (err) {
    console.error(`createRetryFailedCampaignIfNeeded failed for ${campaignId}:`, err);
  }
}
