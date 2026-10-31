import { PutCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

const PHONE_LOOKUP_TABLE = process.env.PHONE_LOOKUP_TABLE || "";

/**
 * Lookup items in a dedicated small table (PK: phoneNumberId → businessId) so
 * webhook-worker.ts can find which business owns an inbound phoneNumberId with a
 * single GetCommand instead of scanning every business record. Deliberately a
 * separate table rather than reusing BusinessesTable — that table's existing Scans
 * (businesses/list.ts) assume every item is a full business record, and mixing in
 * lookup rows there would corrupt that listing.
 * Must be kept in sync whenever a business's phoneNumbers list changes.
 */
export async function upsertPhoneNumberLookups(businessId: string, phoneNumberIds: string[]) {
  if (!PHONE_LOOKUP_TABLE) return;
  for (const phoneNumberId of phoneNumberIds) {
    if (!phoneNumberId) continue;
    await docClient.send(
      new PutCommand({
        TableName: PHONE_LOOKUP_TABLE,
        Item: { PK: phoneNumberId, businessId },
      })
    );
  }
}

export async function removePhoneNumberLookups(phoneNumberIds: string[]) {
  if (!PHONE_LOOKUP_TABLE) return;
  for (const phoneNumberId of phoneNumberIds) {
    if (!phoneNumberId) continue;
    await docClient.send(
      new DeleteCommand({ TableName: PHONE_LOOKUP_TABLE, Key: { PK: phoneNumberId } })
    );
  }
}

export async function lookupBusinessIdByPhoneNumber(phoneNumberId: string): Promise<string | null> {
  if (!PHONE_LOOKUP_TABLE || !phoneNumberId) return null;
  const result = await docClient.send(
    new GetCommand({ TableName: PHONE_LOOKUP_TABLE, Key: { PK: phoneNumberId } })
  );
  return (result.Item?.businessId as string | undefined) || null;
}
