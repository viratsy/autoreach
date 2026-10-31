import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { docClient, TABLES } from "./dynamo";
import { generateCampaignId, buildCampaignName } from "./campaign-id";
import { CampaignRecord, PhoneNumber } from "./types";
import { estimateCost } from "./pricing";

const scheduler = new SchedulerClient({});
const SEND_FUNCTION_ARN = process.env.SEND_FUNCTION_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || "default";

const SCHEDULE_NAME_MAX = 64; // EventBridge Scheduler's own hard cap
const SCHEDULE_NAME_PREFIX = "autoreach-";

/**
 * Builds the EventBridge Scheduler `Name` for a campaign. A campaignId
 * built from a long workshop code + run key (e.g.
 * "currentbatch_ai_in_ms_office_mastery_its_7_20_pm_332876") can push
 * "autoreach-<campaignId>" past the 64-char cap — a real incident where
 * every scheduler call for that campaign (create/cancel/reschedule) failed
 * with ValidationException, and bulk-approve silently reported it as a
 * generic "Internal error". When the natural name fits, it's used as-is
 * for readability; when it doesn't, the middle (the human-readable
 * wsCode/runKey portion) is trimmed while the campaignId's own trailing
 * random suffix (generateCampaignId's uniqueness guarantee) is preserved,
 * so two different long campaignIds can't collide onto the same schedule
 * name any more than they could already collide as campaignIds.
 *
 * MUST be used everywhere a schedule is created, deleted, or looked up for
 * a campaign — any call site building "autoreach-<campaignId>" inline
 * instead silently targets/misses the wrong (or no) schedule once a
 * campaignId is long enough to need trimming.
 */
export function buildScheduleName(campaignId: string): string {
  const full = `${SCHEDULE_NAME_PREFIX}${campaignId}`;
  if (full.length <= SCHEDULE_NAME_MAX) return full;

  const suffixLen = 7; // "_" + generateCampaignId's 6-hex-char suffix
  const suffix = campaignId.slice(-suffixLen);
  const middleBudget = SCHEDULE_NAME_MAX - SCHEDULE_NAME_PREFIX.length - suffixLen;
  const middle = campaignId.slice(0, -suffixLen).slice(0, middleBudget);
  return `${SCHEDULE_NAME_PREFIX}${middle}${suffix}`;
}

export interface CreateScheduledCampaignParams {
  campaignPrefix: string;
  // Overrides what campaignName is built from — campaignPrefix itself stays
  // reserved for campaignId (URL slug, EventBridge schedule name, and the
  // frontend's editCampaignId?.startsWith("currentbatch_") gate all depend
  // on that exact prefix). Lets a caller show something more useful than
  // "currentbatch" in the display name — e.g. current-batch-scheduler.ts
  // uses the batch date, so two campaigns for the same workshop+run key but
  // different batches ("14aug26_..." vs "16aug26_...") are visually
  // distinguishable at a glance instead of looking identical apart from the
  // trailing random suffix.
  displayNamePrefix?: string;
  businessId: string;
  businessName: string;
  selectedNumbers: PhoneNumber[];
  templateName?: string;
  templateCategory?: string;
  templateMappings?: Record<string, string>;
  parameterMapping?: Record<string, string>;
  csvS3Key?: string;
  headerImageUrl?: string;
  numbersWithImageHeader?: string[];
  failureMode?: string;
  autoRetry?: boolean;
  respectUnsubscribeList?: boolean;
  excludePaidUsers?: boolean;
  emailEnabled?: boolean;
  emailTemplateId?: string;
  workshop?: string;
  batch?: string;
  msg?: string;
  totalContacts?: number;
  scheduleDate?: string;
  scheduleTime?: string;
  createdBy: string;
  // Keeps status "draft" and skips creating the EventBridge schedule even
  // when scheduleDate/scheduleTime are populated — used by unattended jobs
  // (current-batch-scheduler.ts) so a human still confirms before anything
  // actually sends. scheduleDate/scheduleTime stay on the record so the
  // team sees the intended time when they review it.
  forceDraft?: boolean;
  // Deterministic dedup key (e.g. "CURRENTBATCH#<wsCode>#<dateYMD>#<runKey>"),
  // written as GSI3PK. Lets an idempotent caller Query-check "did I already
  // create this?" instead of re-creating duplicates on every run.
  idempotencyKey?: string;
}

/**
 * Builds a CampaignRecord, writes it, and creates the matching EventBridge
 * Schedule when a scheduleDate/scheduleTime is given — the same logic
 * campaigns/create.ts (the HTTP handler) uses, lifted out so other callers
 * (Crossale) can create real, visible campaigns the same way rather than
 * duplicating this record shape and scheduling behavior.
 */
export async function createScheduledCampaign(
  params: CreateScheduledCampaignParams
): Promise<{ campaignId: string; campaignName: string }> {
  const campaignId = generateCampaignId(params.campaignPrefix);
  const status = params.forceDraft ? "draft" : params.scheduleDate && params.scheduleTime ? "scheduled" : "draft";
  const now = new Date().toISOString();

  const record: CampaignRecord = {
    PK: `CAMP#${campaignId}`,
    SK: "METADATA",
    GSI1PK: `BIZ#${params.businessId}`,
    GSI1SK: now,
    GSI2PK: `STATUS#${status}`,
    GSI2SK: `${params.scheduleDate}#${params.scheduleTime}`,
    GSI3PK: params.idempotencyKey,
    campaignId,
    campaignName: buildCampaignName(params.displayNamePrefix || params.campaignPrefix, campaignId),
    businessId: params.businessId,
    businessName: params.businessName,
    selectedNumbers: params.selectedNumbers,
    templateName: params.templateName || "",
    templateCategory: params.templateCategory || "UTILITY",
    templateMappings: params.templateMappings || {},
    parameterMapping: params.parameterMapping || {},
    csvS3Key: params.csvS3Key || "",
    headerImageUrl: params.headerImageUrl || "",
    numbersWithImageHeader: params.numbersWithImageHeader || [],
    failureMode: params.failureMode || "reroute",
    autoRetry: params.autoRetry !== false,
    respectUnsubscribeList: params.respectUnsubscribeList !== false,
    excludePaidUsers: params.excludePaidUsers !== false,
    emailEnabled: params.emailEnabled === true,
    emailTemplateId: params.emailTemplateId || undefined,
    retryCount: 0,
    workshop: params.workshop || undefined,
    batch: params.batch || undefined,
    msg: params.msg || undefined,
    totalContacts: params.totalContacts || 0,
    scheduleDate: params.scheduleDate || "",
    scheduleTime: params.scheduleTime || "",
    estimatedCost: estimateCost(params.totalContacts || 0, params.templateCategory || "UTILITY"),
    status,
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: TABLES.CAMPAIGNS, Item: record }));

  if (!params.forceDraft && status === "scheduled" && params.scheduleDate && params.scheduleTime) {
    // Convert IST to UTC for EventBridge (IST = UTC+5:30)
    const istDateTime = new Date(`${params.scheduleDate}T${params.scheduleTime}:00+05:30`);
    const scheduleExpression = `at(${istDateTime.toISOString().replace(".000Z", "")})`;

    await scheduler.send(
      new CreateScheduleCommand({
        Name: buildScheduleName(campaignId),
        GroupName: SCHEDULER_GROUP,
        ScheduleExpression: scheduleExpression,
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: SEND_FUNCTION_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({ campaignId }),
        },
        ActionAfterCompletion: "DELETE",
      })
    );
  }

  return { campaignId, campaignName: record.campaignName };
}

/** Reads IST wall-clock date/time parts out of an absolute instant. */
export function toISTParts(d: Date): { date: string; time: string } {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return { date: ist.toISOString().slice(0, 10), time: ist.toISOString().slice(11, 16) };
}

const SHORT_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "2026-08-14" -> "14aug26" — used as a displayNamePrefix so two campaigns
 * for the same workshop+run key but different batch/promoted dates are
 * visually distinguishable by name, not just by their trailing random
 * suffix. Shared by current-batch-scheduler.ts (batch date) and
 * crossale/create.ts (promoted date).
 */
export function formatBatchDateForName(dateYMD: string): string {
  const [y, m, d] = dateYMD.split("-").map(Number);
  return `${String(d).padStart(2, "0")}${SHORT_MONTHS[m - 1]}${String(y).slice(-2)}`;
}
