import { CSVContact } from "./types";

/**
 * Keeps the first row for each `phone` (the exact string used in the message
 * record key MSG#<phone>) and drops later repeats. Duplicate keys inside one
 * DynamoDB BatchWrite fail the whole call, and a phone listed twice would
 * otherwise also be messaged twice.
 *
 * keepBlank: rows with no phone (email-only rows) are all kept — send.ts needs
 * them for the email batches. The send worker leaves it false, because several
 * blank phones in one WhatsApp batch collide on the same MSG# key.
 */
export function dedupeByPhone(contacts: CSVContact[], opts: { keepBlank?: boolean } = {}): CSVContact[] {
  const seen = new Set<string>();
  const out: CSVContact[] = [];
  for (const c of contacts) {
    const key = c.phone || "";
    if (!key && opts.keepBlank) {
      out.push(c);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
