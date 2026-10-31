import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

const TEMPLATES_TABLE = process.env.TEMPLATES_TABLE || "autoreach-templates";

/**
 * Filters a pool of phone numbers down to the ones that actually have
 * `templateName` approved AND non-MARKETING on that number — same two
 * checks the manual Create Campaign wizard's SelectAdditionalNumbers.tsx
 * already applies client-side (availableOn + categoryPerNumber !==
 * "MARKETING"), just done here as targeted per-number GetItems (cheap for
 * a few dozen numbers) rather than pulling the whole templates table.
 * MARKETING templates carry stricter sending windows/cost and get rerouted
 * away at send time anyway (see send.ts) — excluding them here means a
 * campaign's own selectedNumbers/totalContacts already reflects numbers
 * that will actually carry traffic, instead of only finding out at send
 * time. Shared by current-batch-scheduler.ts and the Crossale campaign
 * creator — both unattended paths that never go through the manual
 * wizard's own filtering.
 */
export async function getAvailableNumbers(
  businessId: string,
  numberIds: string[],
  templateName: string
): Promise<string[]> {
  const results = await Promise.all(
    numberIds.map(async (numId) => {
      try {
        const res = await docClient.send(
          new GetCommand({
            TableName: TEMPLATES_TABLE,
            Key: { PK: `BIZ#${businessId}`, SK: `TPL#${numId}#${templateName}` },
          })
        );
        return res.Item && res.Item.status === "approved" && res.Item.category !== "MARKETING" ? numId : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((id): id is string => Boolean(id));
}

/**
 * Of these numbers, which ones actually have this template approved WITH an
 * image header.
 *
 * The same template name can be approved with a different structure on each
 * number — `20min_hr_bi` exists with an IMAGE header on 4 of H R Academy's
 * numbers and with no header at all on the other 13. Sending a header image to
 * a number whose copy has no header slot is rejected outright by Meta, and the
 * schedulers used to do exactly that: they marked every selected number as
 * taking an image purely because the workshop config carried a headerImageUrl.
 * On 2026-09-17 that silently cost the 7 PM Power BI batch its entire "20 mins
 * to go" send (655 of 655) and most of "60 mins to go" (578 of 682).
 *
 * Campaign creation in the UI has always intersected against the synced
 * template data (SelectTemplate's hasImageHeaderPerNumber); this is the same
 * check for the three automated paths.
 */
export async function filterNumbersWithImageHeader(
  businessId: string,
  templateName: string,
  numberIds: string[]
): Promise<string[]> {
  const results = await Promise.all(
    numberIds.map(async (numId) => {
      try {
        const res = await docClient.send(
          new GetCommand({
            TableName: TEMPLATES_TABLE,
            Key: { PK: `BIZ#${businessId}`, SK: `TPL#${numId}#${templateName}` },
          })
        );
        const components = (res.Item?.components || []) as { type?: string; format?: string }[];
        const hasImageHeader = components.some(
          (c) => String(c.type || "").toUpperCase() === "HEADER" && String(c.format || "").toUpperCase() === "IMAGE"
        );
        return hasImageHeader ? numId : null;
      } catch {
        // Unreadable template data means we cannot prove the number takes an
        // image. Dropping it costs the header; keeping it costs the message.
        return null;
      }
    })
  );
  return results.filter((id): id is string => Boolean(id));
}

export interface TimeLabels {
  timeLabel: string;
  timeShortLabel: string;
  endTimeLabel: string;
}

/**
 * The system only ever templates two workshop slots — 7 PM evening or
 * 11 AM — distinguished today by sniffing "07:00" out of the raw date
 * string stored in WhatsAppDatabase. Pulled out as-is (same check, same
 * output) so nightly-scheduler.ts's behavior doesn't change; Crossale
 * derives the same booleans from its own explicit AM/PM slot picker
 * instead of string-sniffing.
 */
export function deriveTimeLabels(rawDateOrIsEvening: string | boolean): TimeLabels {
  const isEvening =
    typeof rawDateOrIsEvening === "boolean" ? rawDateOrIsEvening : rawDateOrIsEvening.includes("07:00");
  return {
    timeLabel: isEvening ? "07:00 PM IST" : "11:00 AM IST",
    timeShortLabel: isEvening ? "7 PM" : "11 AM",
    endTimeLabel: isEvening ? "10:00 PM" : "2:00 PM",
  };
}

export function formatDateHuman(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = d.getDate();
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const suffix = day === 1 || day === 21 || day === 31 ? "st" : day === 2 || day === 22 ? "nd" : day === 3 || day === 23 ? "rd" : "th";
    return `${day}${suffix} ${months[d.getMonth()]}`;
  } catch {
    return dateStr;
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FULL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-06-03" -> "Wednesday, 03 June 2026". Falls back to the raw string
 * on anything unparseable rather than showing "Invalid Date". */
export function formatWorkshopDateFull(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return `${DAY_NAMES[d.getDay()]}, ${String(d.getDate()).padStart(2, "0")} ${FULL_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * "2026-06-03" + "07:00 PM IST" -> "Wednesday, 03 June 2026 at 07:00PM IST"
 * — workshop_date_time is meant to read as one full sentence, unlike the
 * short workshop_date/workshop_time pieces it's assembled from elsewhere.
 */
export function formatWorkshopDateTime(dateStr: string, timeLabel: string): string {
  const datePart = formatWorkshopDateFull(dateStr);
  const compactTime = timeLabel.replace(/(\d{1,2}:\d{2})\s*(AM|PM)/i, "$1$2");
  return `${datePart} at ${compactTime}`;
}

export interface ReengagementContact {
  phone: string;
  name: string;
  email?: string;
}

/**
 * Builds the full set of template params a workshop re-engagement message
 * can reference for one contact — name/phone/email plus every computed
 * workshop_* / w_* / mentor_name / duration field the existing run-key
 * templates are written against. Used both by nightly-scheduler.ts (fed the
 * OLD batch's date/links) and Crossale's campaign creator (fed the NEW
 * promoted date/links), so a contact promoted to a new batch date gets the
 * new date substituted everywhere the old one used to appear.
 */
export function buildContactParams(
  contact: ReengagementContact,
  workshopName: string,
  workshopDate: string,
  labels: TimeLabels,
  zoomLink: string,
  whatsappLink: string,
  mentorName: string = "Hardik Raja"
): Record<string, string> {
  return {
    phone: contact.phone,
    name: contact.name,
    email: contact.email || "",
    workshop_name: workshopName,
    workshop_date: formatWorkshopDateFull(workshopDate),
    workshop_time: labels.timeLabel,
    zoom_link: zoomLink,
    whatsapp_group: whatsappLink,
    full_workshop_name: `3 Hours Live ${workshopName} Workshop`,
    workshop_name_w: `${workshopName} Workshop`,
    workshop_date_time: formatWorkshopDateTime(workshopDate, labels.timeLabel),
    workshop_time_short: labels.timeShortLabel,
    mentor_name: `${mentorName} (Your Mentor)`,
    w_type: "Workshop",
    w_name: workshopName,
    w_date: formatDateHuman(workshopDate),
    three_hours_text: `3 hours live ${workshopName}`,
    duration: `${labels.timeShortLabel} to ${labels.endTimeLabel} IST`,
  };
}
