import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { docClient, TABLES } from "../../lib/dynamo";
import { getTestNumbers } from "../../lib/test-numbers";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { stringifyCSV } from "../../lib/csv";
import { getAvailableNumbers, filterNumbersWithImageHeader, deriveTimeLabels, buildContactParams, ReengagementContact } from "../../lib/reengagement-contacts";
import { createScheduledCampaign, toISTParts, formatBatchDateForName } from "../../lib/campaign-factory";
import { getRegistryWorkshop } from "../../lib/workshop-registry";
import { queryLeadsByExactDate } from "../../lib/database-leads";
import { PhoneNumber, BusinessRecord } from "../../lib/types";

const s3 = new S3Client({});
const CONFIG_TABLE = process.env.WORKSHOP_CONFIG_TABLE || "autoreach-workshop-config-hardik";
const CSV_BUCKET = process.env.CSV_BUCKET!;
const MENTOR_NAME = process.env.MENTOR_NAME || "Hardik Raja";

const CSV_COLUMNS = [
  "phone", "name", "email", "workshop_name", "workshop_date", "workshop_time",
  "zoom_link", "whatsapp_group", "full_workshop_name", "workshop_name_w",
  "workshop_date_time", "workshop_time_short", "mentor_name", "w_type",
  "w_name", "w_date", "three_hours_text", "duration",
];

interface RunKeySelection {
  runKey: string;
  templateName: string;
  bodyParams: string[];
  headerImageUrl?: string;
  offsetMinutes?: number;
}

/**
 * Creates one real, visible Campaign per selected run key from a chosen set
 * of past workshop batches, promoted to a new date. Unlike
 * nightly-scheduler.ts (which pushes straight to SQS, invisible in
 * Campaigns), this builds a CSV audience and goes through the same
 * createScheduledCampaign() path the normal campaign wizard uses.
 * POST /crossale/create
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  const authEmail = getAuthEmail(event);
  if (!authEmail) return error(401, "Unauthorized", origin);

  try {
    const body = JSON.parse(event.body || "{}");
    const {
      wsCode,
      workshopName,
      targetWsCode,
      targetWorkshopName,
      businessId,
      batchDates,
      promotedDate,
      promotedTime, // "HH:MM" 24h IST
      zoomLink,
      whatsappGroup,
      runKeys,
      selectedNumberIds,
    }: {
      wsCode: string;
      workshopName: string;
      // The workshop actually being promoted — independent of wsCode
      // (the audience source). Drives Workshop Config lookup, the CSV's
      // workshop_name, campaign naming/tagging. wsCode/workshopName stay
      // scoped to pulling the right leads and nothing else below.
      targetWsCode: string;
      targetWorkshopName: string;
      businessId: string;
      batchDates: string[];
      promotedDate: string;
      promotedTime: string;
      zoomLink?: string;
      whatsappGroup?: string;
      runKeys: RunKeySelection[];
      // Manual mode's user-picked sending pool — bypasses Workshop Config
      // entirely. Trusting a client-supplied phoneNumberId list here is
      // safe: getAvailableNumbers() below checks approval under
      // BIZ#<businessId>, so an id that doesn't actually belong to this
      // business just matches nothing and gets filtered out.
      selectedNumberIds?: string[];
    } = body;

    // The audience can be pooled from several past workshops at once — you
    // might promote one new batch to everyone who attended Power BI AND
    // AI in MS Office Mastery. Sources only ever decide which leads get
    // pulled; everything downstream (config, CSV content, campaign naming)
    // keys off targetWsCode, so pooling changes nothing else.
    // Older clients send a single wsCode + batchDates instead.
    const sources: { wsCode: string; batchDates: string[] }[] =
      Array.isArray(body.sources) && body.sources.length
        ? body.sources.filter(
            (s: { wsCode?: string; batchDates?: string[] }) => s?.wsCode && s.batchDates?.length
          )
        : wsCode && batchDates?.length
          ? [{ wsCode, batchDates }]
          : [];

    if (
      !sources.length ||
      !targetWsCode ||
      !targetWorkshopName ||
      !businessId ||
      !promotedDate ||
      !promotedTime ||
      !runKeys?.length
    ) {
      return error(400, "Missing required fields", origin);
    }

    // Sending pool: a manually-picked list wins (Manual mode) over the
    // server's own copy of the TARGET workshop's Workshop Config (Auto
    // mode) — same trust boundary either way, since getAvailableNumbers
    // scopes its lookup to this businessId regardless of where the id
    // list came from.
    const configResult = await docClient.send(
      new GetCommand({ TableName: CONFIG_TABLE, Key: { PK: `WSCONFIG#${targetWsCode}`, SK: "CYCLE#0" } })
    );
    const wsConfig = configResult.Item;
    const sendingPool = selectedNumberIds?.length ? selectedNumberIds : Object.keys(wsConfig?.numbers || {});
    if (sendingPool.length === 0) {
      return error(400, selectedNumberIds ? "No sending numbers selected" : `No sending numbers configured for ${targetWsCode} in Workshop Config`, origin);
    }

    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item as BusinessRecord | undefined;
    if (!business) return error(404, "Business not found", origin);
    const numbersById = new Map((business.phoneNumbers || []).map((pn) => [pn.phoneNumberId, pn]));

    // Pull leads for every selected batch date, across every exact
    // workshop_name string this workshop is known to register under. No
    // status/converted filtering here — the raw leads table has no such
    // concept; already-paid contacts get skipped the same way any normal
    // campaign skips them, via excludePaidUsers at send time.

    // The name actually substituted into message content — the base
    // WhatsAppDatabase name (e.g. "Power BI"), not the registry's
    // time-suffixed displayName ("Power BI 7 PM") the frontend picker
    // shows for telling the two time-variant configs apart. Falls back to
    // the client-supplied targetWorkshopName only if the target code
    // somehow isn't in the registry (shouldn't happen — the frontend picks
    // targetWsCode from this same registry).
    const targetRegistryWorkshop = await getRegistryWorkshop(targetWsCode);
    const targetParamName = targetRegistryWorkshop?.whatsappDbName || targetWorkshopName;

    // Deduped by phone across every source, so someone who attended two of
    // the selected workshops is messaged once, not twice.
    const contactsByPhone = new Map<string, { phone: string; name: string; email?: string }>();
    for (const source of sources) {
      const registryWorkshop = await getRegistryWorkshop(source.wsCode);
      if (!registryWorkshop) return error(400, `Unknown workshop code ${source.wsCode}`, origin);

      await Promise.all(
        registryWorkshop.candidates.flatMap((name) =>
          source.batchDates.map(async (bd: string) => {
            const leads = await queryLeadsByExactDate(name, bd);
            for (const lead of leads) {
              if (lead.phone) contactsByPhone.set(lead.phone, { phone: lead.phone, name: lead.name || "", email: lead.email });
            }
          })
        )
      );
    }
    if (contactsByPhone.size === 0) {
      return error(400, "No contacts found for the selected batches", origin);
    }

    // QA/team numbers (lib/test-numbers.ts) always ride along in every
    // Crossale audience — added after real leads so a genuine registrant
    // with the same phone still wins.
    for (const tn of await getTestNumbers()) {
      if (tn.phone) contactsByPhone.set(tn.phone, { phone: tn.phone, name: tn.name });
    }
    const contacts = Array.from(contactsByPhone.values());

    // Same param set for every run key — only templateName/bodyParams differ
    // per campaign, so one CSV upload covers all of them.
    const labels = deriveTimeLabels(promotedTime >= "17:00");
    const records = contacts.map((c) =>
      buildContactParams(
        { phone: c.phone, name: c.name, email: c.email } as ReengagementContact,
        targetParamName,
        promotedDate,
        labels,
        zoomLink || "",
        whatsappGroup || "",
        MENTOR_NAME
      )
    );
    const csv = stringifyCSV(CSV_COLUMNS, records);
    const csvS3Key = `uploads/${Date.now()}_crossale_${targetWsCode}.csv`;
    await s3.send(
      new PutObjectCommand({ Bucket: CSV_BUCKET, Key: csvS3Key, Body: csv, ContentType: "text/csv" })
    );

    const promotedMoment = new Date(`${promotedDate}T${promotedTime}:00+05:30`);
    const created: { campaignId: string; campaignName: string; runKey: string; scheduleDate: string; scheduleTime: string }[] = [];
    const warnings: string[] = [];

    for (const rk of runKeys) {
      if (!rk.templateName) {
        warnings.push(`${rk.runKey}: no template configured, skipped`);
        continue;
      }

      const availableIds = await getAvailableNumbers(businessId, sendingPool, rk.templateName);
      if (availableIds.length === 0) {
        warnings.push(`${rk.runKey}: no sending numbers have "${rk.templateName}" approved, skipped`);
        continue;
      }
      const selectedNumbers: PhoneNumber[] = availableIds
        .map((id) => numbersById.get(id))
        .filter((n): n is PhoneNumber => Boolean(n));

      const offsetMs = (rk.offsetMinutes || 0) * 60 * 1000;
      const sendMoment = new Date(promotedMoment.getTime() - offsetMs);
      if (sendMoment.getTime() <= Date.now()) {
        warnings.push(`${rk.runKey}: computed send time is in the past, skipped`);
        continue;
      }
      const { date: scheduleDate, time: scheduleTime } = toISTParts(sendMoment);

      const parameterMapping = Object.fromEntries(
        (rk.bodyParams || []).map((p, pi) => [
          String(pi + 1),
          p.startsWith("__CUSTOM__") ? `__STATIC__${wsConfig?.customParams?.[p.replace("__CUSTOM__", "")] || ""}` : p,
        ])
      );

      // See filterNumbersWithImageHeader — the same template name can be
      // approved with an image header on some numbers and none on others.
      const imageHeaderNumbers = rk.headerImageUrl
        ? await filterNumbersWithImageHeader(
            businessId,
            rk.templateName,
            selectedNumbers.map((n) => n.phoneNumberId)
          )
        : [];

      const { campaignId, campaignName } = await createScheduledCampaign({
        campaignPrefix: `crossale_${targetWsCode}_${rk.runKey}`,
        // "cs_" marks this as Crossale-sourced (vs current-batch-scheduler's
        // plain date-first name) — short enough not to clutter the name
        // while still distinguishing the two creation paths at a glance.
        // rk.runKey deliberately left out here — in Manual mode it's a
        // free-text label the user types per message (e.g. "AI Tools + AI in
        // MS Office_B200_CS-9am_GJ"), and appending that blew the display
        // name up to something unreadable in the campaigns list. campaignId
        // (campaignPrefix above) still carries the full runKey for
        // uniqueness; only the human-facing name is shortened.
        displayNamePrefix: `cs_${formatBatchDateForName(promotedDate)}_${targetWsCode}`,
        businessId,
        businessName: business.businessName,
        selectedNumbers,
        templateName: rk.templateName,
        templateCategory: "UTILITY",
        parameterMapping,
        csvS3Key,
        headerImageUrl: rk.headerImageUrl || "",
        numbersWithImageHeader: imageHeaderNumbers,
        // Registry code, matching current-batch-scheduler — see the note there.
        workshop: targetWsCode,
        batch: promotedDate,
        msg: rk.runKey,
        totalContacts: contacts.length,
        scheduleDate,
        scheduleTime,
        createdBy: authEmail,
      });

      created.push({ campaignId, campaignName, runKey: rk.runKey, scheduleDate, scheduleTime });
    }

    return success({ created, warnings, totalContacts: contacts.length }, origin);
  } catch (err) {
    console.error("Crossale create error:", err);
    return error(500, "Failed to create crossale campaigns", origin);
  }
};
