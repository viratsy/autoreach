import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { PhoneNumber } from "../../lib/types";

interface HealthEntity {
  entity_type?: string;
  id?: string;
  can_send_message?: string;
  errors?: { error_code?: number; error_description?: string; possible_solution?: string }[];
}
interface HealthResult {
  canSendMessage: string;
  healthErrors: { code?: number; description?: string; solution?: string }[];
}
interface WabaHealth {
  overall: HealthResult;
  byPhoneNumberId: Map<string, HealthResult>;
}

const toHealthErrors = (errors?: { error_code?: number; error_description?: string; possible_solution?: string }[]) =>
  (errors || []).map((e) => ({ code: e.error_code, description: e.error_description, solution: e.possible_solution }));

// health_status lives on the WABA, not the phone number — one GET per unique
// WABA covers every number under it (a business's numbers can span several
// WABAs, same fan-out whatsapp-spend.ts already deals with), unlike
// quality_rating/messaging_limit_tier/status below which are per-number.
// This is what actually surfaces a payment/billing block (can_send_message:
// "BLOCKED" with an error whose description names the billing issue)
// WITHOUT sending any message — Meta only reports that via a real send
// otherwise, which is what test-send.ts's webhook-poll dance works around.
// Confirmed against a real (healthy) account: Meta only returns a
// PHONE_NUMBER-level entity when there's something specific to report about
// it — a WABA with no issues just returns WABA/BUSINESS/APP entities, no
// per-number breakdown — so every number under a WABA falls back to that
// WABA's own top-level can_send_message/errors when no PHONE_NUMBER entity
// names it specifically.
async function fetchHealthByWaba(wabaIds: string[], accessToken: string): Promise<Map<string, WabaHealth>> {
  const byWaba = new Map<string, WabaHealth>();

  await Promise.all(
    wabaIds.map(async (wabaid) => {
      try {
        const res = await fetch(`https://graph.facebook.com/v25.0/${wabaid}?fields=health_status`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = (await res.json()) as {
          health_status?: { can_send_message?: string; entities?: HealthEntity[] };
          error?: { message?: string };
        };
        if (data.error) {
          console.log(`[quality-check] health_status wabaid=${wabaid} metaError=${JSON.stringify(data.error)}`);
          return;
        }

        const entities = data.health_status?.entities || [];
        const wabaEntity = entities.find((e) => e.entity_type === "WABA");
        const byPhoneNumberId = new Map<string, HealthResult>();
        for (const entity of entities) {
          if (entity.entity_type !== "PHONE_NUMBER" || !entity.id) continue;
          byPhoneNumberId.set(entity.id, {
            canSendMessage: entity.can_send_message || "UNKNOWN",
            healthErrors: toHealthErrors(entity.errors),
          });
        }

        byWaba.set(wabaid, {
          overall: {
            canSendMessage: data.health_status?.can_send_message || wabaEntity?.can_send_message || "UNKNOWN",
            healthErrors: toHealthErrors(wabaEntity?.errors),
          },
          byPhoneNumberId,
        });
      } catch (err) {
        console.log(`[quality-check] health_status wabaid=${wabaid} threw:`, err);
      }
    })
  );

  return byWaba;
}

/**
 * Check quality rating AND messaging health (incl. payment/billing blocks)
 * for phone numbers — read-only, no message sent.
 * POST /businesses/quality-check { businessId, phoneNumberIds }
 * If phoneNumberIds is empty/null, checks all numbers in the business.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const { businessId, phoneNumberIds } = JSON.parse(event.body || "{}");
    if (!businessId) return error(400, "businessId is required", origin);

    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);

    const accessToken = business.accessToken;
    const allNumbers = business.phoneNumbers || [];

    // Filter to requested numbers or check all
    const numbersToCheck = phoneNumberIds?.length
      ? allNumbers.filter((pn: { phoneNumberId: string }) => phoneNumberIds.includes(pn.phoneNumberId))
      : allNumbers;

    const wabaIds = Array.from(
      new Set(numbersToCheck.map((pn: PhoneNumber) => pn.wabaid).filter((w: string | undefined): w is string => Boolean(w)))
    ) as string[];
    const healthByWaba = wabaIds.length ? await fetchHealthByWaba(wabaIds, accessToken) : new Map<string, WabaHealth>();

    const results: Record<
      string,
      { qualityRating: string; messagingLimit: string; status: string; canSendMessage: string; healthErrors: { code?: number; description?: string; solution?: string }[] }
    > = {};

    for (const pn of numbersToCheck) {
      const wabaHealth = pn.wabaid ? healthByWaba.get(pn.wabaid) : undefined;
      // Prefer a PHONE_NUMBER-specific entry when Meta names this number
      // directly; otherwise fall back to the WABA's own overall status —
      // see fetchHealthByWaba's comment for why that fallback is necessary.
      const health = wabaHealth?.byPhoneNumberId.get(pn.phoneNumberId) || wabaHealth?.overall;
      try {
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${pn.phoneNumberId}?fields=quality_rating,messaging_limit_tier,status`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const data = (await res.json()) as { quality_rating?: string; messaging_limit_tier?: string; status?: string };
        results[pn.phoneNumberId] = {
          qualityRating: data.quality_rating || "UNKNOWN",
          messagingLimit: data.messaging_limit_tier || "",
          status: data.status || "",
          canSendMessage: health?.canSendMessage || "UNKNOWN",
          healthErrors: health?.healthErrors || [],
        };
      } catch {
        results[pn.phoneNumberId] = {
          qualityRating: "UNKNOWN",
          messagingLimit: "",
          status: "",
          canSendMessage: health?.canSendMessage || "UNKNOWN",
          healthErrors: health?.healthErrors || [],
        };
      }
    }

    // Persist the results onto the business record so other parts of the system
    // (e.g. round-robin distribution at send time) can read a cached quality/tier
    // value without making a live Meta API call in the send path.
    const updatedNumbers: PhoneNumber[] = allNumbers.map((pn: PhoneNumber) => {
      const r = results[pn.phoneNumberId];
      return r ? { ...pn, qualityRating: r.qualityRating, messagingLimit: r.messagingLimit } : pn;
    });

    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.BUSINESSES,
        Key: { PK: `BIZ#${businessId}`, SK: "METADATA" },
        UpdateExpression: "SET phoneNumbers = :numbers, updatedAt = :now",
        ExpressionAttributeValues: { ":numbers": updatedNumbers, ":now": new Date().toISOString() },
      })
    );

    return success({ results }, origin);
  } catch (err) {
    console.error("Quality check error:", err);
    return error(500, "Failed to check quality", origin);
  }
};
