import { nanoid } from "nanoid";

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

  const suffix = nanoid(6);
  return `${sanitized}_${suffix}`;
}
