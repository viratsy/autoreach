import { PhoneNumber, CSVContact } from "./types";

export interface DistributedContact {
  contact: CSVContact;
  assignedNumber: PhoneNumber;
}

/**
 * Distribute contacts evenly across sending numbers using round-robin.
 * Example: 10,000 contacts across 3 numbers = ~3,333 each.
 */
export function distributeContacts(
  contacts: CSVContact[],
  numbers: PhoneNumber[]
): DistributedContact[] {
  if (numbers.length === 0) {
    throw new Error("At least one sending number is required");
  }

  return contacts.map((contact, index) => ({
    contact,
    assignedNumber: numbers[index % numbers.length],
  }));
}

// Meta's WhatsApp per-number 24h messaging tiers (messaging_limit_tier values).
export const TIER_CAPS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_10K: 10000,
  TIER_100K: 100000,
  TIER_UNLIMITED: Infinity,
};

function tierCap(messagingLimit?: string): number {
  if (!messagingLimit) return Infinity; // no cached tier — don't constrain (today's behavior)
  return TIER_CAPS[messagingLimit] ?? Infinity;
}

/**
 * Drops numbers Meta has flagged RED quality (same spirit as the MARKETING-category
 * exclusion already done for templates). Numbers with no cached rating yet (nobody
 * has run quality-check) are treated as healthy — this must fail open, not block a
 * campaign just because quality hasn't been checked. Never returns an empty list.
 */
export function filterHealthyNumbers(numbers: PhoneNumber[]): PhoneNumber[] {
  const healthy = numbers.filter((n) => n.qualityRating !== "RED");
  return healthy.length > 0 ? healthy : numbers;
}

/**
 * Distributes contacts across numbers, weighted by each number's cached 24h
 * messaging tier so a TIER_250 number doesn't get the same share as a TIER_10K
 * number. Falls back to a plain even split (identical to distributeContacts)
 * when no number has a cached tier yet, so campaigns before anyone has run
 * quality-check behave exactly as before.
 */
export function distributeContactsWeighted(
  contacts: CSVContact[],
  numbers: PhoneNumber[]
): Record<string, CSVContact[]> {
  if (numbers.length === 0) {
    throw new Error("At least one sending number is required");
  }

  const perNumber: Record<string, CSVContact[]> = {};
  numbers.forEach((n) => { perNumber[n.phoneNumberId] = []; });

  const caps = numbers.map((n) => tierCap(n.messagingLimit));
  const hasAnyTierData = caps.some((c) => Number.isFinite(c));

  if (!hasAnyTierData) {
    contacts.forEach((contact, i) => {
      perNumber[numbers[i % numbers.length].phoneNumberId].push(contact);
    });
    return perNumber;
  }

  // Numbers with no cached tier get the average of the known finite caps, so
  // they aren't starved just for lacking a quality-check run.
  const finiteCaps = caps.filter((c) => Number.isFinite(c));
  const avgFiniteCap = finiteCaps.reduce((a, b) => a + b, 0) / finiteCaps.length;
  const weights = caps.map((c) => (Number.isFinite(c) ? c : avgFiniteCap));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Largest-remainder method: base share by floor(), then hand out the leftover
  // contacts one at a time to whichever number's share had the biggest fraction,
  // so the counts always sum to exactly contacts.length.
  const rawShares = weights.map((w) => (w / totalWeight) * contacts.length);
  const baseShares = rawShares.map(Math.floor);
  const distributed = baseShares.reduce((a, b) => a + b, 0);
  let remaining = contacts.length - distributed;

  const byRemainder = rawShares
    .map((s, i) => ({ i, frac: s - baseShares[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remaining && byRemainder.length > 0; k++) {
    baseShares[byRemainder[k % byRemainder.length].i]++;
  }

  let idx = 0;
  numbers.forEach((n, i) => {
    const count = baseShares[i];
    perNumber[n.phoneNumberId] = contacts.slice(idx, idx + count);
    idx += count;
  });

  return perNumber;
}

/**
 * Get distribution summary for preview.
 */
export function getDistributionSummary(
  totalContacts: number,
  numbers: PhoneNumber[]
): { phoneNumberId: string; displayNumber: string; count: number }[] {
  const base = Math.floor(totalContacts / numbers.length);
  const remainder = totalContacts % numbers.length;

  return numbers.map((number, index) => ({
    phoneNumberId: number.phoneNumberId,
    displayNumber: number.displayNumber,
    count: base + (index < remainder ? 1 : 0),
  }));
}
