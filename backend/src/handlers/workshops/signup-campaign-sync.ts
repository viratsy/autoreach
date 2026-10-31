import { Handler } from "aws-lambda";
import { BatchWriteCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { formatBatchDateForName } from "../../lib/campaign-factory";
import { listRegistryWorkshops, RegistryWorkshop } from "../../lib/workshop-registry";
import { STATS_SK } from "../../lib/campaign-stats";
import { BusinessRecord, PhoneNumber } from "../../lib/types";

/**
 * Mirrors signup confirmations into read-only campaigns, one per workshop date
 * ("24oct26_claudebusi_signup"), so their delivery funnel shows up in the
 * campaigns list next to everything else.
 *
 * free_workshop_meta sends those messages itself and logs each one to
 * comm_messages; the webhook worker keeps those rows' status current (see
 * lib/comm-messages.ts). comm_messages stays the single source of truth —
 * this job only projects it, every 10 minutes, so it is safe to re-run and
 * there is nothing to reconcile if a run is missed.
 *
 * The mirrored message rows deliberately carry no GSI1 (METAMSG#) or GSI4
 * (PHONE#) keys: the webhook worker would otherwise start updating them
 * directly, and trackCampaignReply would credit a contact's reply to the
 * signup campaign instead of the real campaign they replied to.
 */

const COMM_TABLE = process.env.COMM_TABLE || "comm_messages";
const RUN_KEY_INDEX = "run_key-date_ymd-index";
const SIGNUP_RUN_KEY = "signup_msg";
// Registrations for a workshop can trickle in for weeks before it, so the
// read window has to cover the whole run-up — otherwise early signups would
// fall out of the window and the counts would shrink as it slides.
const LOOKBACK_DAYS = 30;
// Once a workshop is a few days past, its numbers stop moving; leave its
// campaign frozen rather than re-deriving it every run.
const KEEP_SYNCING_DAYS_AFTER = 3;
const CAMPAIGN_PREFIX = "signup_";

type Item = Record<string, unknown>;

interface Contact {
  phone: string;
  status: "sent" | "delivered" | "read" | "failed";
  rank: number;
  sentAt: string;
  sendingNumberId: string;
  repliedAt: string | null;
  replyText: string;
  errorCode: string | null;
}

interface Group {
  code: string;
  dateYMD: string;
  scheduleTime: string;
  templateName: string;
  workshopName: string;
  contacts: Map<string, Contact>;
  senderIds: Set<string>;
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 0 };

function istDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-23 22:15:23" (IST) -> ISO UTC. */
function istToIso(tsIst: string | undefined): string {
  if (!tsIst) return new Date().toISOString();
  const d = new Date(`${tsIst.replace(" ", "T")}+05:30`);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** "Saturday, 24 Oct 2026, 11:00 am IST" -> "11:00". */
function parseTime(workshopDate: string): string {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(workshopDate || "");
  if (!m) return "";
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function toContact(row: Item): Contact {
  const raw = String(row.status || "").toUpperCase();
  const failed = raw === "FAILED" || raw === "ERROR";
  const status: Contact["status"] = failed
    ? "failed"
    : raw === "READ" || raw === "REPLIED"
      ? "read"
      : raw === "DELIVERED"
        ? "delivered"
        : "sent";
  const replyTs = row.last_reply_ts as number | undefined;
  const err = row.error as unknown;
  return {
    phone: String(row.to || ""),
    status,
    rank: RANK[status],
    sentAt: istToIso(row.ts_ist as string),
    sendingNumberId: String(row.from_pnid || ""),
    repliedAt: raw === "REPLIED" || replyTs ? new Date(Number(replyTs) || Date.now()).toISOString() : null,
    replyText: String(row.last_reply_text || ""),
    errorCode: failed
      ? Array.isArray(err) && err[0] && typeof err[0] === "object"
        ? String((err[0] as Item).code ?? "")
        : String(err ?? "send_failed").slice(0, 100)
      : null,
  };
}

/** Keeps the furthest-progressed attempt when one person signed up twice. */
function better(a: Contact, b: Contact): Contact {
  const best = b.rank > a.rank ? b : a;
  return best.repliedAt || !(a.repliedAt || b.repliedAt)
    ? best
    : { ...best, repliedAt: a.repliedAt || b.repliedAt, replyText: a.replyText || b.replyText };
}

function resolveCode(registry: RegistryWorkshop[], workshopName: string, wsCode: string, time: string): string {
  const name = workshopName.trim().toLowerCase();
  const matches = registry.filter((w) => w.candidates.some((c) => c.trim().toLowerCase() === name));
  if (matches.length === 1) return matches[0].code;
  if (matches.length > 1 && time) {
    // Time-variant siblings ("Power BI 7 PM" / "11AM") share one name; tell
    // them apart by the session hour.
    const hour = Number(time.slice(0, 2));
    const label = `${hour % 12 || 12}${hour >= 12 ? "pm" : "am"}`;
    const byTime = matches.find((w) => (w.time || "").toLowerCase() === label);
    if (byTime) return byTime.code;
  }
  return matches[0]?.code || wsCode || "unknown";
}

async function readSignupRows(): Promise<Item[]> {
  const rows: Item[] = [];
  let lastKey: Item | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: COMM_TABLE,
        IndexName: RUN_KEY_INDEX,
        KeyConditionExpression: "run_key = :rk AND date_ymd BETWEEN :from AND :to",
        ExpressionAttributeValues: { ":rk": SIGNUP_RUN_KEY, ":from": istDate(-LOOKBACK_DAYS), ":to": istDate(1) },
        ExclusiveStartKey: lastKey,
      })
    );
    rows.push(...((res.Items as Item[]) || []));
    lastKey = res.LastEvaluatedKey as Item | undefined;
  } while (lastKey);
  return rows;
}

async function batchPut(items: Item[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let requests = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    // UnprocessedItems must be retried, or rows silently go missing under throttling.
    for (let attempt = 0; requests.length && attempt < 6; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      const res = await docClient.send(new BatchWriteCommand({ RequestItems: { [TABLES.MESSAGES]: requests } }));
      requests = (res.UnprocessedItems?.[TABLES.MESSAGES] || []) as typeof requests;
    }
    if (requests.length) throw new Error(`${requests.length} message rows still unprocessed after retries`);
  }
}

async function existingRows(campaignId: string): Promise<Map<string, Item>> {
  const out = new Map<string, Item>();
  let lastKey: Item | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLES.MESSAGES,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :msg)",
        ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":msg": "MSG#" },
        ProjectionExpression: "SK, #s, repliedAt",
        ExpressionAttributeNames: { "#s": "status" },
        ExclusiveStartKey: lastKey,
      })
    );
    for (const it of (res.Items as Item[]) || []) out.set(it.SK as string, it);
    lastKey = res.LastEvaluatedKey as Item | undefined;
  } while (lastKey);
  return out;
}

async function syncGroup(g: Group, numbers: Map<string, { business: BusinessRecord; number: PhoneNumber }>, fallback: BusinessRecord) {
  const campaignId = `${CAMPAIGN_PREFIX}${g.code}_${g.dateYMD.replace(/-/g, "")}`;
  const pk = `CAMP#${campaignId}`;
  const contacts = [...g.contacts.values()];

  // The business that sent most of them owns the campaign; signups for one
  // workshop can go out from numbers in more than one business.
  const tally = new Map<string, number>();
  for (const id of g.senderIds) {
    const b = numbers.get(id)?.business.businessId;
    if (b) tally.set(b, (tally.get(b) || 0) + 1);
  }
  const ownerId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const owner = (ownerId && [...numbers.values()].find((n) => n.business.businessId === ownerId)?.business) || fallback;
  const selectedNumbers = [...g.senderIds].map((id) => numbers.get(id)?.number).filter(Boolean) as PhoneNumber[];
  const now = new Date().toISOString();

  // 1. Campaign record — created once, then only its size is kept current.
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLES.CAMPAIGNS,
        ConditionExpression: "attribute_not_exists(PK)",
        Item: {
          PK: pk,
          SK: "METADATA",
          GSI1PK: `BIZ#${owner.businessId}`,
          GSI1SK: now,
          GSI2PK: "STATUS#completed",
          GSI2SK: `${g.dateYMD}#${g.scheduleTime}`,
          campaignId,
          campaignName: `${formatBatchDateForName(g.dateYMD)}_${g.code}_signup`,
          businessId: owner.businessId,
          businessName: owner.businessName,
          selectedNumbers,
          templateName: g.templateName,
          templateCategory: "UTILITY",
          templateMappings: {},
          parameterMapping: {},
          csvS3Key: "",
          headerImageUrl: "",
          numbersWithImageHeader: [],
          failureMode: "reroute",
          autoRetry: false,
          respectUnsubscribeList: true,
          excludePaidUsers: false,
          emailEnabled: false,
          retryCount: 0,
          workshop: g.code,
          batch: g.dateYMD,
          msg: "signup",
          totalContacts: contacts.length,
          scheduleDate: g.dateYMD,
          scheduleTime: g.scheduleTime,
          status: "completed",
          createdBy: "signup-campaign-sync",
          createdAt: now,
          updatedAt: now,
        },
      })
    );
    console.log(`created ${campaignId} for "${g.workshopName}" (${contacts.length} signups)`);
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: pk, SK: "METADATA" },
        // Only rewritten when it grew — this record is ~4KB and costly to touch.
        ConditionExpression: "totalContacts <> :n",
        UpdateExpression: "SET totalContacts = :n, selectedNumbers = :sn, updatedAt = :now",
        ExpressionAttributeValues: { ":n": contacts.length, ":sn": selectedNumbers, ":now": now },
      })
    ).catch((e) => {
      if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
    });
  }

  // 2. Per-contact rows, written only where something changed.
  const existing = await existingRows(campaignId);
  const changed = contacts.filter((c) => {
    const row = existing.get(`MSG#${c.phone}`);
    return !row || row.status !== c.status || (!!c.repliedAt && !row.repliedAt);
  });
  await batchPut(
    changed.map((c) => ({
      PK: pk,
      SK: `MSG#${c.phone}`,
      GSI3PK: `${pk}#STATUS#${c.status}`,
      GSI3SK: `MSG#${c.phone}`,
      phoneNumber: c.phone,
      contactName: "",
      sendingNumberId: c.sendingNumberId,
      metaMessageId: "",
      status: c.status,
      repliedAt: c.repliedAt,
      replyText: c.replyText || undefined,
      errorCode: c.errorCode,
      sentAt: c.sentAt,
      updatedAt: now,
    }))
  );

  // 3. Counters — absolute, recomputed from scratch. METADATA never carries
  // counters for these campaigns, so STATS alone is the whole number.
  const reached = (min: number) => contacts.filter((c) => c.rank >= min).length;
  await docClient.send(
    new PutCommand({
      TableName: TABLES.CAMPAIGNS,
      Item: {
        PK: pk,
        SK: STATS_SK,
        sentCount: contacts.length,
        deliveredCount: reached(2),
        readCount: reached(3),
        repliedCount: contacts.filter((c) => c.repliedAt).length,
        failedCount: contacts.filter((c) => c.status === "failed").length,
        skippedCount: 0,
      },
    })
  );
  return { campaignId, total: contacts.length, written: changed.length };
}

export const handler: Handler = async () => {
  const [rows, registry, bizScan] = await Promise.all([
    readSignupRows(),
    listRegistryWorkshops(),
    docClient.send(new ScanCommand({ TableName: TABLES.BUSINESSES })),
  ]);
  const businesses = (bizScan.Items || []) as BusinessRecord[];
  const numbers = new Map<string, { business: BusinessRecord; number: PhoneNumber }>();
  for (const b of businesses) for (const n of b.phoneNumbers || []) numbers.set(n.phoneNumberId, { business: b, number: n });
  const fallback = [...businesses].sort((a, b) => (b.phoneNumbers?.length || 0) - (a.phoneNumbers?.length || 0))[0];
  if (!fallback) {
    console.error("no businesses — nothing to attach signup campaigns to");
    return;
  }

  const cutoff = istDate(-KEEP_SYNCING_DAYS_AFTER);
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (row.channel && row.channel !== "whatsapp") continue;
    // message_key = "<workshopDateYMD>#<ws_code>#<phone>#<ts>#whatsapp"
    const dateYMD = String(row.message_key || "").split("#")[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYMD) || dateYMD < cutoff || !row.to) continue;
    const workshopName = String(row.workshop_name || "");
    const time = parseTime(String(row.workshop_date || ""));
    const code = resolveCode(registry, workshopName, String(row.ws_code || ""), time);
    const key = `${code}#${dateYMD}`;
    let g = groups.get(key);
    if (!g) {
      g = { code, dateYMD, scheduleTime: time, templateName: String(row.template || ""), workshopName, contacts: new Map(), senderIds: new Set() };
      groups.set(key, g);
    }
    const c = toContact(row);
    const prev = g.contacts.get(c.phone);
    g.contacts.set(c.phone, prev ? better(prev, c) : c);
    if (c.sendingNumberId) g.senderIds.add(c.sendingNumberId);
    if (!g.templateName && row.template) g.templateName = String(row.template);
  }

  console.log(`${rows.length} signup rows -> ${groups.size} active workshop groups`);
  if (process.env.DRY_RUN) {
    for (const g of groups.values()) {
      const cs = [...g.contacts.values()];
      console.log(
        `${formatBatchDateForName(g.dateYMD)}_${g.code}_signup "${g.workshopName}" ${g.scheduleTime}: ` +
          `${cs.length} contacts, delivered ${cs.filter((c) => c.rank >= 2).length}, ` +
          `read ${cs.filter((c) => c.rank >= 3).length}, replied ${cs.filter((c) => c.repliedAt).length}, ` +
          `failed ${cs.filter((c) => c.status === "failed").length}, numbers ${g.senderIds.size}`
      );
    }
    return;
  }
  for (const g of groups.values()) {
    try {
      const r = await syncGroup(g, numbers, fallback);
      console.log(`${r.campaignId}: ${r.total} contacts, ${r.written} rows written`);
    } catch (err) {
      console.error(`sync failed for ${g.code} ${g.dateYMD}:`, err);
    }
  }
};
