import { Handler } from "aws-lambda";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { docClient, TABLES } from "../../lib/dynamo";
import { getTestNumbers } from "../../lib/test-numbers";
import { parseCSVWithHeaders, stringifyCSV } from "../../lib/csv";
import { getAvailableNumbers, filterNumbersWithImageHeader, buildContactParams, ReengagementContact, TimeLabels } from "../../lib/reengagement-contacts";
import { createScheduledCampaign, toISTParts, formatBatchDateForName } from "../../lib/campaign-factory";
import { listRegistryWorkshops } from "../../lib/workshop-registry";
import { queryLeadsByExactDate } from "../../lib/database-leads";
import { getCurrentBatch } from "../../lib/whatsapp-database";
import { inferRunKeyOffset, toSignedMinutes } from "../../lib/runKeyOffset";
import { PhoneNumber, BusinessRecord, CampaignRecord } from "../../lib/types";
import { preflightCampaign } from "../../lib/campaign-preflight";
import { createNotification } from "../notifications/index";
import { findEmailTemplateByRunKey } from "../../lib/email-templates";

const s3 = new S3Client({});
const CONFIG_TABLE = process.env.WORKSHOP_CONFIG_TABLE || "autoreach-workshop-config-hardik";
const CSV_BUCKET = process.env.CSV_BUCKET!;
const CAMPAIGNS_TABLE = TABLES.CAMPAIGNS;
const MENTOR_NAME = process.env.MENTOR_NAME || "Hardik Raja";

// Campaigns this job creates go straight to "scheduled" when they pass
// pre-flight, instead of waiting for someone to approve them. Set
// AUTO_APPROVE_CURRENT_BATCH=false to put the manual gate back without a code
// change — a kill switch worth having on something that sends unattended.
const AUTO_APPROVE = process.env.AUTO_APPROVE_CURRENT_BATCH !== "false";

// Only create a run key's draft once its computed send time is within this
// window — creating it too far ahead means the audience snapshot (taken at
// creation time) goes stale before a team member actually reviews and
// confirms it. Re-evaluated every night, so a run key further out just gets
// picked up on a later run once it falls inside the window.
const CREATE_WINDOW_MS = 48 * 60 * 60 * 1000;

const CSV_COLUMNS = [
  "phone", "name", "email", "workshop_name", "workshop_date", "workshop_time",
  "zoom_link", "whatsapp_group", "full_workshop_name", "workshop_name_w",
  "workshop_date_time", "workshop_time_short", "mentor_name", "w_type",
  "w_name", "w_date", "three_hours_text", "duration",
];

interface RunKeyConfig {
  templateName: string;
  bodyParams: string[];
  headerImageUrl?: string;
  offsetMinutes?: number;
}

/**
 * Unattended counterpart to Crossale, run every 30 minutes — for a
 * workshop's CURRENT (still-registering) batch rather than a past one.
 * Resolves the batch's real date/zoom/WhatsApp from WhatsAppDatabase,
 * pulls the actual registrants for that exact batch from the same real
 * leads table Crossale queries, and either creates one DRAFT campaign per
 * newly-due run key, or tops up an already-created run key's campaign
 * (draft OR scheduled/approved) with anyone who registered since it was
 * last touched. Creation deliberately lands as draft (not auto-scheduled)
 * — a team member still has to open and confirm it; but once approved
 * (status "scheduled"), this job keeps appending new registrants to its
 * CSV right up until send.ts reads it fresh at fire time, so a late
 * registrant is never missed just because the campaign was approved
 * early.
 *
 * Idempotent via GSI3 (GSI3PK = "CURRENTBATCH#<wsCode>#<dateYMD>#<runKey>"),
 * written only by this job — every run resolves the same batch date for a
 * given workshop until WhatsAppDatabase's pre_date/Date actually rolls
 * over, so a run key's campaign is always found (and topped up) under the
 * exact same key it was created with — never mixed with a later batch's
 * registrants.
 */
export const handler: Handler = async () => {
  const workshops = await listRegistryWorkshops();
  console.log(`current-batch-scheduler: checking ${workshops.length} registered workshops`);

  for (const ws of workshops) {
    try {
      await processWorkshop(ws.code, ws.candidates, ws.whatsappDbName, ws.time);
    } catch (err) {
      console.error(`current-batch-scheduler: error processing ${ws.code}`, err);
    }
  }

  console.log("current-batch-scheduler complete");
};

async function processWorkshop(
  wsCode: string,
  candidates: string[],
  whatsappDbName: string,
  time?: string
) {
  const batch = await getCurrentBatch(whatsappDbName, time);
  if (!batch) {
    console.log(
      `${wsCode}: no upcoming batch found in WhatsAppDatabase for "${whatsappDbName}"${time ? ` @ ${time}` : ""}, skipping`
    );
    return;
  }

  const configResult = await docClient.send(
    new GetCommand({ TableName: CONFIG_TABLE, Key: { PK: `WSCONFIG#${wsCode}`, SK: "CYCLE#0" } })
  );
  const wsConfig = configResult.Item;
  if (!wsConfig?.businessId) {
    console.log(`${wsCode}: no businessId in Workshop Config, skipping`);
    return;
  }
  const sendingPool: string[] = Object.keys(wsConfig.numbers || {});
  if (sendingPool.length === 0) {
    console.log(`${wsCode}: no sending numbers configured, skipping`);
    return;
  }

  const runKeys: Record<string, RunKeyConfig> = wsConfig.runKeys || {};
  const activeRunKeys: string[] = wsConfig.activeRunKeys || Object.keys(runKeys);

  const now = Date.now();
  const toCreate: { runKey: string; config: RunKeyConfig; sendMoment: Date }[] = [];
  const toTopUp: { runKey: string; campaign: CampaignRecord }[] = [];

  for (const runKey of activeRunKeys) {
    const cfg = runKeys[runKey];
    if (!cfg?.templateName) continue;

    const offsetMinutes = cfg.offsetMinutes ?? inferDefault(runKey, batch.timeLabel);
    const sendMoment = new Date(batch.instant.getTime() - offsetMinutes * 60000);
    const idempotencyKey = `CURRENTBATCH#${wsCode}#${batch.dateYMD}#${runKey}`;

    const existing = await findExistingCampaign(idempotencyKey);
    if (existing) {
      // Top-up stays eligible purely on status — draft (not yet approved)
      // or scheduled (approved, still hasn't fired) — regardless of how
      // close sendMoment is; send.ts reads the CSV fresh at fire time, so
      // there's no "too late to top up" cutoff to enforce here.
      if (existing.status === "draft" || existing.status === "scheduled") {
        toTopUp.push({ runKey, campaign: existing });
      }
      continue;
    }

    if (sendMoment.getTime() <= now) continue; // already past, never created — nothing to do now
    if (sendMoment.getTime() - now > CREATE_WINDOW_MS) continue; // not due yet, picked up later

    toCreate.push({ runKey, config: cfg, sendMoment });
  }

  if (toCreate.length === 0 && toTopUp.length === 0) {
    console.log(`${wsCode}: nothing to create or top up`);
    return;
  }

  // Whoever's registered for this exact batch, across every exact
  // workshop_name string this workshop is known to register under — same
  // helper Crossale uses. No status/converted filtering; already-paid
  // contacts get skipped the normal way, via excludePaidUsers at send time.
  const contactsByPhone = new Map<string, { phone: string; name: string; email?: string }>();
  await Promise.all(
    candidates.map(async (name) => {
      const leads = await queryLeadsByExactDate(name, batch.dateYMD);
      for (const lead of leads) {
        if (lead.phone) contactsByPhone.set(lead.phone, { phone: lead.phone, name: lead.name || "", email: lead.email });
      }
    })
  );

  // QA/team numbers (lib/test-numbers.ts) always ride along in every
  // current-batch audience — added after real leads so a genuine
  // registrant with the same phone still wins.
  for (const tn of await getTestNumbers()) {
    if (tn.phone) contactsByPhone.set(tn.phone, { phone: tn.phone, name: tn.name });
  }
  const contacts = Array.from(contactsByPhone.values());

  if (contacts.length === 0) {
    console.log(`${wsCode}: no registrants found for batch ${batch.dateYMD}`);
    return;
  }

  const labels: TimeLabels = { timeLabel: batch.timeLabel, timeShortLabel: batch.timeShortLabel, endTimeLabel: batch.endTimeLabel };

  if (toCreate.length > 0) {
    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${wsConfig.businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item as BusinessRecord | undefined;
    if (!business) {
      console.log(`${wsCode}: business ${wsConfig.businessId} not found, skipping creation`);
    } else {
      const numbersById = new Map((business.phoneNumbers || []).map((pn) => [pn.phoneNumberId, pn]));

      const records = contacts.map((c) =>
        buildContactParams(
          { phone: c.phone, name: c.name, email: c.email } as ReengagementContact,
          whatsappDbName,
          batch.dateYMD,
          labels,
          batch.zoomLink,
          batch.whatsappLink,
          MENTOR_NAME
        )
      );
      const csv = stringifyCSV(CSV_COLUMNS, records);
      const csvS3Key = `uploads/${Date.now()}_currentbatch_${wsCode}.csv`;
      await s3.send(new PutObjectCommand({ Bucket: CSV_BUCKET, Key: csvS3Key, Body: csv, ContentType: "text/csv" }));

      for (const { runKey, config, sendMoment } of toCreate) {
        const availableIds = await getAvailableNumbers(wsConfig.businessId, sendingPool, config.templateName);
        if (availableIds.length === 0) {
          console.log(`${wsCode}/${runKey}: no sending numbers have "${config.templateName}" approved, skipping`);
          continue;
        }
        const selectedNumbers: PhoneNumber[] = availableIds
          .map((id) => numbersById.get(id))
          .filter((n): n is PhoneNumber => Boolean(n));

        // Only the numbers whose approved copy actually has an image header —
        // see filterNumbersWithImageHeader. Marking a number that has no header
        // slot gets every one of its messages rejected by Meta.
        const imageHeaderNumbers = config.headerImageUrl
          ? await filterNumbersWithImageHeader(
              wsConfig.businessId as string,
              config.templateName,
              selectedNumbers.map((n) => n.phoneNumberId)
            )
          : [];
        if (config.headerImageUrl && imageHeaderNumbers.length < selectedNumbers.length) {
          console.warn(
            `${wsCode}/${runKey}: ${selectedNumbers.length - imageHeaderNumbers.length} of ` +
              `${selectedNumbers.length} numbers have "${config.templateName}" approved WITHOUT an ` +
              `image header — they will send text-only rather than fail`
          );
        }

        const { date: scheduleDate, time: scheduleTime } = toISTParts(sendMoment);
        const parameterMapping = Object.fromEntries(
          (config.bodyParams || []).map((p, pi) => [
            String(pi + 1),
            p.startsWith("__CUSTOM__") ? `__STATIC__${wsConfig.customParams?.[p.replace("__CUSTOM__", "")] || ""}` : p,
          ])
        );

        // Auto-approve, but only what passes pre-flight.
        //
        // Creating these as drafts was meant to keep a human in the loop. In
        // practice the 08:00 run key went unapproved 17 batches running, and
        // 72 expired drafts covering 91,244 recipients were never sent at all.
        // The checks a human was theoretically making are the ones in
        // preflightCampaign, and a machine does them on every single campaign
        // rather than on the ones somebody happened to open in time.
        const issues = AUTO_APPROVE
          ? await preflightCampaign({
              businessId: wsConfig.businessId as string,
              templateName: config.templateName,
              phoneNumberIds: selectedNumbers.map((n) => n.phoneNumberId),
              headerImageUrl: config.headerImageUrl,
              csvBucket: CSV_BUCKET,
            })
          : [{ code: "image_missing" as const, detail: "auto-approve disabled" }];

        const blocked = issues.length > 0;
        if (blocked && AUTO_APPROVE) {
          const detail = issues.map((i) => i.detail).join("; ");
          console.warn(`${wsCode}/${runKey}: HELD AS DRAFT — ${detail}`);
          // Surfaced rather than only logged: a campaign that quietly stays a
          // draft is precisely the failure this change exists to end.
          await createNotification({
            type: "campaign_stuck",
            businessId: (wsConfig.businessId as string) || "",
            businessName: business.businessName || "",
            phoneNumberId: "",
            phoneDisplayName: "",
            templateName: config.templateName,
            errorMessage: `${wsCode}/${runKey} needs attention before it can send: ${detail}`,
          }).catch((err) => console.error("preflight notification failed", err));
        }

        // Email goes out alongside WhatsApp whenever a library template claims
        // this run key (one_day_to_go for 1day_to_go, we_are_live, …). Nothing
        // used to switch this on, so every scheduler campaign was WhatsApp-only
        // unless someone remembered to edit it by hand. The CSV built above
        // already carries every field those templates use (zoom_link,
        // whatsapp_group, workshop_date_time, …), and email-worker still skips
        // any contact missing one. A lookup failure only costs the email.
        const emailTemplate = await findEmailTemplateByRunKey(runKey).catch((err) => {
          console.error(`${wsCode}/${runKey}: email template lookup failed — WhatsApp only`, err);
          return null;
        });

        const { campaignId } = await createScheduledCampaign({
          campaignPrefix: `currentbatch_${wsCode}_${runKey}`,
          displayNamePrefix: `${formatBatchDateForName(batch.dateYMD)}_${wsCode}_${runKey}`,
          businessId: wsConfig.businessId,
          businessName: business.businessName,
          selectedNumbers,
          templateName: config.templateName,
          templateCategory: "UTILITY",
          parameterMapping,
          csvS3Key,
          headerImageUrl: config.headerImageUrl || "",
          numbersWithImageHeader: imageHeaderNumbers,
          // The registry CODE, not the display name. This field is what the
          // campaign name is rebuilt from whenever a draft is edited, and
          // "AI in MS Office Mastery_2026-09-18_1day_to_go_55fa74" is unreadable
          // in a table. Total Cost groups on this too, so its rows now read
          // "ai_mastery" rather than the full title.
          workshop: wsCode,
          batch: batch.dateYMD,
          msg: runKey,
          totalContacts: contacts.length,
          scheduleDate,
          scheduleTime,
          createdBy: "current-batch-scheduler",
          // Passes pre-flight -> scheduled, with its EventBridge schedule
          // created now. Fails -> stays a draft for a human, exactly as before.
          forceDraft: blocked,
          emailEnabled: !!emailTemplate,
          emailTemplateId: emailTemplate?.templateId,
          idempotencyKey: `CURRENTBATCH#${wsCode}#${batch.dateYMD}#${runKey}`,
        });

        console.log(
          `${wsCode}/${runKey}: created ${blocked ? "DRAFT (held)" : "SCHEDULED"} ${campaignId} ` +
            `for ${contacts.length} contacts at ${scheduleDate} ${scheduleTime}`
        );
      }
    }
  }

  if (toTopUp.length > 0) {
    // Multiple run keys can point at the SAME csvS3Key — the toCreate branch
    // above builds one shared CSV per batch and reuses it across every run
    // key created together. Group by key and top up each unique object
    // once, then sync every campaign record sharing it — processing them
    // independently would have the first one fix the shared file and every
    // sibling after it see "no new contacts" in the now-already-fixed file,
    // silently leaving their own totalContacts stale.
    const byCsvKey = new Map<string, { runKey: string; campaign: CampaignRecord }[]>();
    for (const entry of toTopUp) {
      if (!entry.campaign.csvS3Key) continue;
      const list = byCsvKey.get(entry.campaign.csvS3Key) || [];
      list.push(entry);
      byCsvKey.set(entry.campaign.csvS3Key, list);
    }
    for (const [csvS3Key, entries] of byCsvKey) {
      await topUpSharedCsv(wsCode, csvS3Key, entries, contacts, whatsappDbName, labels, batch.zoomLink, batch.whatsappLink);
    }
  }
}

async function findExistingCampaign(idempotencyKey: string): Promise<CampaignRecord | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: CAMPAIGNS_TABLE,
      IndexName: "GSI3",
      KeyConditionExpression: "GSI3PK = :k",
      ExpressionAttributeValues: { ":k": idempotencyKey },
      Limit: 1,
    })
  );
  const pk = result.Items?.[0]?.PK as string | undefined;
  if (!pk) return null;

  const full = await docClient.send(new GetCommand({ TableName: CAMPAIGNS_TABLE, Key: { PK: pk, SK: "METADATA" } }));
  return (full.Item as CampaignRecord) || null;
}

/**
 * Diffs the current registrant list against what's already in a shared
 * draft/scheduled CSV (by phone), appends only the new rows, and re-uploads
 * once — then syncs totalContacts on every campaign record that points at
 * this same csvS3Key to the resulting real row count, not just "+= new
 * rows", since a sibling record's own stored count can already be stale
 * relative to the shared file (e.g. this same key was already topped up
 * once this run for another run key sharing it). Safe for a `scheduled`
 * campaign too — send.ts re-reads the CSV fresh from S3 at fire time, so
 * this never needs to touch the EventBridge schedule itself.
 */
async function topUpSharedCsv(
  wsCode: string,
  csvS3Key: string,
  entries: { runKey: string; campaign: CampaignRecord }[],
  contacts: { phone: string; name: string; email?: string }[],
  whatsappDbName: string,
  labels: TimeLabels,
  zoomLink: string,
  whatsappLink: string
) {
  // Skip the S3 round-trip only if EVERY record sharing this key already
  // has enough — if even one is stale, we still need the real row count to
  // resync it.
  if (entries.every((e) => contacts.length <= (e.campaign.totalContacts || 0))) return;

  const csvResult = await s3.send(new GetObjectCommand({ Bucket: CSV_BUCKET, Key: csvS3Key }));
  const csvText = await csvResult.Body!.transformToString();
  const { headers, records } = parseCSVWithHeaders(csvText);
  const existingPhones = new Set(records.map((r) => r.phone));
  const newContacts = contacts.filter((c) => !existingPhones.has(c.phone));

  let finalCount = records.length;
  if (newContacts.length > 0) {
    const newRecords = newContacts.map((c) =>
      buildContactParams(
        { phone: c.phone, name: c.name, email: c.email } as ReengagementContact,
        whatsappDbName,
        entries[0].campaign.batch || "",
        labels,
        zoomLink,
        whatsappLink,
        MENTOR_NAME
      )
    );
    const merged = [...records, ...newRecords];
    const newCsv = stringifyCSV(headers.length ? headers : CSV_COLUMNS, merged);
    await s3.send(new PutObjectCommand({ Bucket: CSV_BUCKET, Key: csvS3Key, Body: newCsv, ContentType: "text/csv" }));
    finalCount = merged.length;
  }

  for (const { runKey, campaign } of entries) {
    if ((campaign.totalContacts || 0) === finalCount) continue;
    await docClient.send(
      new UpdateCommand({
        TableName: CAMPAIGNS_TABLE,
        Key: { PK: campaign.PK, SK: campaign.SK },
        UpdateExpression: "SET totalContacts = :n, updatedAt = :now",
        ExpressionAttributeValues: { ":n": finalCount, ":now": new Date().toISOString() },
      })
    );
    console.log(
      `${wsCode}/${runKey}: synced ${campaign.campaignId} (${campaign.status}) totalContacts ${campaign.totalContacts || 0} -> ${finalCount}`
    );
  }
}

function inferDefault(runKey: string, timeLabel: string): number {
  // timeLabel is "07:00 PM IST" — reduce to "19:00" 24h for the inference
  // helper, which expects the same shape Crossale's promotedTime picker uses.
  const inferred = inferRunKeyOffset(runKey, to24Hour(timeLabel));
  return inferred ? toSignedMinutes(inferred.minutes, inferred.direction) : 0;
}

/** "07:00 PM IST" / "7:10 AM" → "HH:MM" 24h. */
function to24Hour(label: string): string {
  const m = label.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return "00:00";
  let hour = parseInt(m[1], 10);
  const minute = m[2];
  const isPM = m[3].toUpperCase() === "PM";
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}
