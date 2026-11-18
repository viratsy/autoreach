import { CSVContact } from "./types";

/**
 * Keeps the first row for each `phone` (the exact string used in the message
 * record key MSG#<phone>) and drops later repeats. Duplicate keys inside one
 * DynamoDB BatchWrite fail the whole call, and a phone listed twice would
 * otherwise also be messaged twice.
 */
export function dedupeByPhone(contacts: CSVContact[]): CSVContact[] {
  const seen = new Set<string>();
  const out: CSVContact[] = [];
  for (const c of contacts) {
    const key = c.phone || "";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
