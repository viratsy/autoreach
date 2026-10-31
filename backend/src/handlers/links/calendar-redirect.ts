import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";
import { docClient } from "../../lib/dynamo";

const WHATSAPP_DB_TABLE = process.env.WHATSAPP_DATABASE_TABLE || "WhatsAppDatabase";
const WORKSHOP_DURATION_HOURS = 3;

/**
 * Short "add to calendar" link: /c/{code} -> 302 to a Google Calendar
 * prefilled-event URL.
 *
 * The code is `<hash7>-<YYYYMMDDHHmm>`, e.g. "a3f9c1b-202609131900":
 *   - hash7 identifies the workshop (sha1 of its WhatsAppDatabase Name)
 *   - the timestamp is baked in rather than re-read at click time
 *
 * Baking the time in matters: WhatsAppDatabase's Date rolls forward to the
 * next batch, so a link that re-read it would silently start pointing at a
 * later session than the one the recipient actually signed up for. It also
 * means no storage at all — nothing is written when a signup goes out, so
 * this adds no new failure mode to the lead-capture path.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const code = event.pathParameters?.code || "";
  const match = code.match(/^([a-z0-9]{4,12})-(\d{12})$/i);
  if (!match) return html(400, "Invalid link", "That calendar link isn't valid.");

  const [, hash, stamp] = match;

  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(8, 10));
  const minute = Number(stamp.slice(10, 12));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return html(400, "Invalid link", "That calendar link isn't valid.");
  }

  let title = "Workshop";
  let location = "LIVE on Zoom";
  let joinLink = "";
  try {
    const res = await docClient.send(
      new ScanCommand({
        TableName: WHATSAPP_DB_TABLE,
        ProjectionExpression: "#n, Workshop, ZoomLink, #d",
        ExpressionAttributeNames: { "#n": "Name", "#d": "Date" },
      })
    );
    const row = (res.Items || []).find((i) => workshopHash(String(i.Name || "")) === hash.toLowerCase());
    if (row) {
      title = String(row.Workshop || row.Name || "Workshop");

      // Only surface the Zoom link when Date still describes the SAME batch
      // this link was generated for. ZoomLink changes per batch and the date
      // here is frozen at signup time, so once the table rolls forward its
      // current link would hand someone the right date with the wrong
      // meeting. Better to show no link than a misleading one.
      //
      // pre_date/pre_ZoomLink are deliberately ignored: only one session is
      // live at a time, and Date/ZoomLink is that session.
      if (row.ZoomLink && parseWorkshopStamp(String(row.Date || "")) === stamp) {
        joinLink = String(row.ZoomLink);
        location = joinLink;
      }
    }
  } catch (err) {
    // A lookup failure shouldn't 500 the recipient — fall through with the
    // generic title so the event still lands on their calendar at the right
    // time, which is the part that actually matters.
    console.error("Workshop lookup failed:", err);
  }

  const start = `${stamp.slice(0, 8)}T${stamp.slice(8, 12)}00`;
  const end = addHours(stamp, WORKSHOP_DURATION_HOURS);
  const detailLines = [
    title,
    `📅 ${formatHuman(year, month, day)}`,
    `⏰ ${format12h(hour, minute)} - ${format12h((hour + WORKSHOP_DURATION_HOURS) % 24, minute)} IST`,
    `📍 LIVE on Zoom`,
  ];
  if (joinLink) detailLines.push("", `🔗 Join: ${joinLink}`);
  const details = detailLines.join("\n");

  // render?action=TEMPLATE rather than /u/0/r/eventedit — the latter pins the
  // event to the viewer's FIRST Google account, which breaks for anyone
  // signed into more than one.
  const url =
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${encodeURIComponent(title)}` +
    `&dates=${start}/${end}` +
    "&ctz=Asia/Kolkata" +
    `&location=${encodeURIComponent(location)}` +
    `&details=${encodeURIComponent(details)}`;

  return {
    statusCode: 302,
    headers: { Location: url, "Cache-Control": "public, max-age=3600" },
    body: "",
  };
};

/**
 * "Sunday, 13 Sep 2026, 07:00 pm IST" -> "202609131900".
 * Returns "" for the rows carrying junk (#N/A, NA, "29 Jun, Monday"), which
 * simply means the batch can't be matched and the Zoom link is withheld.
 */
export function parseWorkshopStamp(raw: string): string {
  const m = raw.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return "";
  const day = Number(m[1]);
  const monthIdx = MONTHS.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase());
  if (monthIdx < 0) return "";
  const year = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  if (m[6].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (m[6].toLowerCase() === "am" && hour === 12) hour = 0;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}${p(monthIdx + 1)}${p(day)}${p(hour)}${p(minute)}`;
}

/** Must stay identical to the generator in free_workshop_meta. */
export function workshopHash(name: string): string {
  return createHash("sha1").update(name.trim().toLowerCase()).digest("hex").slice(0, 7);
}

function addHours(stamp: string, hours: number): string {
  const d = new Date(
    Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12))
    )
  );
  d.setUTCHours(d.getUTCHours() + hours);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
}

function format12h(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${h}:00 ${period}` : `${h}:${String(minute).padStart(2, "0")} ${period}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatHuman(y: number, m: number, d: number): string {
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function html(status: number, title: string, message: string) {
  return {
    statusCode: status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><div style="font-family:system-ui;padding:2rem;text-align:center"><h2>${title}</h2><p>${message}</p></div>`,
  };
}
