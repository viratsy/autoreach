import { ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

const REGISTRY_TABLE = process.env.WORKSHOP_REGISTRY_TABLE || "autoreach-workshop-registry-hardik";

export interface RegistryWorkshop {
  code: string;
  displayName: string;
  aliases: string[];
  // dedup([displayName, ...aliases]) — the exact workshop_name string
  // variants a given workshop is registered under in the raw leads
  // database. Different landing pages/campaigns for the same workshop
  // wrote different literal `workshop_name` values, so a single query
  // against one string misses rows written under the others.
  candidates: string[];
  // The WhatsAppDatabase row's `Name` key to resolve the current batch
  // from — defaults to displayName, which is correct for the common
  // single-time workshop. A workshop run at two different times of day
  // (e.g. "Power BI 7 PM" and "Power BI 11AM") shares ONE WhatsAppDatabase
  // row under the base name ("Power BI"), so both time-variant codes need
  // this set explicitly to that shared base name.
  whatsappDbName: string;
  // "7pm" / "11am" — which of WhatsAppDatabase's two lookahead slots
  // (pre_date vs Date) belongs to this code when whatsappDbName is shared
  // with a sibling time-variant. Passed to getCurrentBatch() to filter by
  // clock hour. Undefined for a single-time workshop, where either slot
  // is a valid match regardless of hour.
  time?: string;
}

function toRegistryWorkshop(code: string, item: Record<string, unknown>): RegistryWorkshop {
  const displayName = (item.displayName as string) || code;
  const aliases = (item.aliases as string[]) || [];
  const whatsappDbName = (item.whatsappDbName as string) || displayName;
  const time = item.time as string | undefined;
  // Real leads get written under whatsappDbName's base name too (e.g. "Power
  // BI", not "Power BI 7 PM") whenever a workshop's landing page/lead form
  // was never told about the time-variant split — same class of mismatch as
  // aliases already exist to cover, so it's included here rather than
  // requiring a redundant manual alias entry.
  const candidates = Array.from(new Set([displayName, whatsappDbName, ...aliases].filter(Boolean)));
  return { code, displayName, aliases, candidates, whatsappDbName, time };
}

export async function listRegistryWorkshops(): Promise<RegistryWorkshop[]> {
  const result = await docClient.send(new ScanCommand({ TableName: REGISTRY_TABLE }));
  return (result.Items || []).map((item) => toRegistryWorkshop(item.code as string, item));
}

export async function getRegistryWorkshop(code: string): Promise<RegistryWorkshop | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: REGISTRY_TABLE, Key: { PK: `WORKSHOP#${code}`, SK: "METADATA" } })
  );
  if (!result.Item) return null;
  return toRegistryWorkshop(code, result.Item);
}
