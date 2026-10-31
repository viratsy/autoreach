import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

const WHATSAPP_DATABASE_TABLE = process.env.WHATSAPP_DATABASE_TABLE || "WhatsAppDatabase";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface ParsedWorkshopDate {
  instant: Date;
  dateYMD: string; // "2026-08-12"
  timeLabel: string; // "07:00 PM IST"
  timeShortLabel: string; // "7 PM"
  endTimeLabel: string; // "10:00 PM" — start + 3h, matching the fixed workshop-duration convention used elsewhere
}

/**
 * Parses WhatsAppDatabase's date strings — e.g.
 * "Wednesday, 12 Aug 2026, 07:00 pm IST" — into a real instant. Native
 * Date parsing of this exact shape (lowercase am/pm, "IST" abbreviation) is
 * unreliable across JS engines, so this is a dedicated regex parse instead
 * of trusting `new Date(raw)`.
 */
export function parseWorkshopDateString(raw: string): ParsedWorkshopDate | null {
  const m = raw.match(/^\w+,\s*(\d{1,2})\s+(\w{3})\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*IST$/i);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  let hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const isPM = m[6].toLowerCase() === "pm";
  if (!month) return null;

  const hour12 = hour;
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;

  const pad = (n: number) => String(n).padStart(2, "0");
  const dateYMD = `${year}-${pad(month)}-${pad(day)}`;
  const instant = new Date(`${dateYMD}T${pad(hour)}:${pad(minute)}:00+05:30`);
  if (isNaN(instant.getTime())) return null;

  const ampmLabel = isPM ? "PM" : "AM";

  // Workshop end time — start + 3 hours, same fixed-duration convention
  // deriveTimeLabels() uses (7pm → 10pm, 11am → 2pm).
  const endHour24 = (hour + 3) % 24;
  const endIsPM = endHour24 >= 12;
  const endHour12 = endHour24 % 12 === 0 ? 12 : endHour24 % 12;
  const endAmpmLabel = endIsPM ? "PM" : "AM";

  return {
    instant,
    dateYMD,
    timeLabel: `${pad(hour12)}:${pad(minute)} ${ampmLabel} IST`,
    timeShortLabel: minute === 0 ? `${hour12} ${ampmLabel}` : `${hour12}:${pad(minute)} ${ampmLabel}`,
    endTimeLabel: minute === 0 ? `${endHour12}:00 ${endAmpmLabel}` : `${endHour12}:${pad(minute)} ${endAmpmLabel}`,
  };
}

export interface CurrentBatch {
  instant: Date;
  dateYMD: string;
  timeLabel: string;
  timeShortLabel: string;
  endTimeLabel: string;
  zoomLink: string;
  whatsappLink: string;
}

/**
 * Resolves a workshop's current (soonest upcoming) batch from
 * WhatsAppDatabase. Each item holds two lookahead batches — `pre_*` (sooner)
 * and the main fields (next after that). Team's own words on the rule:
 * "we change the date on the day of workshop so if pre date is pass the
 * current date we will use Date else we will use pre date and its
 * details." i.e. use pre_* while pre_date is still upcoming; once it's
 * passed, fall back to the main Date/ZoomLink/WhatsappLink.
 *
 * A workshop that runs at two different times of day (e.g. "Power BI 7 PM"
 * and "Power BI 11AM") shares ONE WhatsAppDatabase row under the base name
 * ("Power BI") — pre_date/Date aren't "the 7pm slot" and "the 11am slot"
 * respectively, they're just "whichever's soonest" and "whichever's next
 * after that" across BOTH times combined, and which physical slot currently
 * occupies which field flips as each time-variant's own date rolls forward
 * independently. So when expectedTime is given (from the registry's `time`
 * field, e.g. "7pm"), both pre_date and Date are checked and only the one
 * whose actual clock hour matches is considered a candidate for THIS
 * time-variant — the other slot belongs to the sibling workshop code.
 * Without expectedTime (the common single-time-workshop case), behavior is
 * unchanged: soonest future slot wins regardless of hour.
 *
 * Returns null if no slot both matches expectedTime (when given) and is
 * still in the future.
 */
export async function getCurrentBatch(workshopName: string, expectedTime?: string): Promise<CurrentBatch | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: WHATSAPP_DATABASE_TABLE, Key: { Name: workshopName } })
  );
  const item = result.Item;
  if (!item) return null;

  const now = Date.now();
  const expected = expectedTime ? parseExpectedTime(expectedTime) : null;

  const candidates: { parsed: ParsedWorkshopDate; zoomLink: string; whatsappLink: string }[] = [];
  const pre = item.pre_date ? parseWorkshopDateString(item.pre_date) : null;
  if (pre) candidates.push({ parsed: pre, zoomLink: item.pre_ZoomLink || "", whatsappLink: item.pre_WhatsappLink || "" });
  const main = item.Date ? parseWorkshopDateString(item.Date) : null;
  if (main) candidates.push({ parsed: main, zoomLink: item.ZoomLink || "", whatsappLink: item.WhatsappLink || "" });

  const eligible = candidates.filter(
    (c) => c.parsed.instant.getTime() > now && (!expected || istHour(c.parsed.instant) === expected.hour)
  );
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => a.parsed.instant.getTime() - b.parsed.instant.getTime());
  const chosen = eligible[0];
  return {
    instant: chosen.parsed.instant,
    dateYMD: chosen.parsed.dateYMD,
    timeLabel: chosen.parsed.timeLabel,
    timeShortLabel: chosen.parsed.timeShortLabel,
    endTimeLabel: chosen.parsed.endTimeLabel,
    zoomLink: chosen.zoomLink,
    whatsappLink: chosen.whatsappLink,
  };
}

function istHour(d: Date): number {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours();
}

/** "7pm" / "11am" / "7:30pm" → 24h hour/minute. */
function parseExpectedTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const isPM = m[3].toLowerCase() === "pm";
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  return { hour, minute };
}
