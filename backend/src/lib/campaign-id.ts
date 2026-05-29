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
