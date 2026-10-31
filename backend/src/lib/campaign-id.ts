import { randomBytes } from "crypto";

/**
 * Generate a campaign ID from user prefix + unique suffix.
 * Example: "diwali_offer" → "diwali_offer_a3x9k2"
 */
export function generateCampaignId(prefix: string): string {
  const sanitized = prefix
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  const suffix = randomBytes(4).toString("hex").slice(0, 6);
  return `${sanitized}_${suffix}`;
}

/**
 * Builds the human-facing campaign name: the display prefix plus the id's
 * uniqueness suffix, e.g. ("AICA B22_Main_1st Reminder", "aica_b22_main_1st_reminder_49925c")
 * → "AICA B22_Main_1st Reminder_49925c".
 *
 * The id is sanitized to lowercase/underscores; the NAME is not, which is why
 * these are built separately. Deriving the name from the id instead — as
 * duplicate.ts used to — silently flattens "AICA B22" into "aica_b22".
 */
export function buildCampaignName(displayPrefix: string, campaignId: string): string {
  // An id with no underscore has no suffix to carry over — `split("_").pop()`
  // would hand back the whole id and produce "name_name".
  const lastUnderscore = campaignId.lastIndexOf("_");
  if (lastUnderscore === -1) return displayPrefix;
  return `${displayPrefix}_${campaignId.slice(lastUnderscore + 1)}`;
}
