import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail, isServiceCall } from "../../lib/auth";
import { PhoneNumber } from "../../lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;
// API Gateway REST APIs hard-kill the connection at 29s no matter what the
// Lambda's own Timeout is set to — there's no way to raise that ceiling, so
// every WABA fetch gets its own budget well under it, capped in parallel.
const PER_WABA_TIMEOUT_MS = 15000;

const digitsOnly = (s: string) => (s || "").replace(/\D/g, "");

// A single element of pricing_analytics.data is grouped by whatever
// dimensions were requested (here just PHONE) and holds its own nested
// data_points array — the actual cost/volume/phone_number live one level
// deeper than the outer array, confirmed against a real account's response:
// [{ data_points: [{ start, end, phone_number, volume, cost }, ...] }]
interface PricingDataPoint {
  cost?: number;
  volume?: number;
  phone_number?: string;
}
interface PricingGroup {
  data_points?: PricingDataPoint[];
}

async function fetchWithTimeout(url: string, accessToken: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Real spend Meta has billed, per phone number — a companion to the
 * self-estimated Total Cost page, sourced from the WhatsApp Business
 * Account's `pricing_analytics` field rather than our own per-message rate
 * table. Meta bills per WABA, not per number, and a business's numbers can
 * (per PhoneNumber.wabaid) belong to different WABAs — some real accounts
 * here have 20+ distinct WABAs, so these are fetched in parallel (a
 * sequential loop blew past API Gateway's 29s hard timeout and came back as
 * a 502 with that many WABAs).
 * GET /businesses/whatsapp-spend?businessId=xxx&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  // Read-only, and the one endpoint a machine needs: the accounting stack pulls this
  // once a month so the WhatsApp bill lands on the P&L without anyone retyping it.
  if (!getAuthEmail(event) && !isServiceCall(event)) return error(401, "Unauthorized", origin);

  try {
    const businessId = event.queryStringParameters?.businessId;
    if (!businessId) return error(400, "businessId is required", origin);

    const now = Date.now();
    const dateFrom = event.queryStringParameters?.dateFrom;
    const dateTo = event.queryStringParameters?.dateTo;
    const startMs = dateFrom ? new Date(`${dateFrom}T00:00:00+05:30`).getTime() : now - 30 * DAY_MS;
    const endMs = dateTo ? new Date(`${dateTo}T23:59:59+05:30`).getTime() : now;
    if (isNaN(startMs) || isNaN(endMs)) return error(400, "Invalid dateFrom/dateTo", origin);

    const bizResult = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    const business = bizResult.Item;
    if (!business) return error(404, "Business not found", origin);
    if ((business.provider || "meta") !== "meta") {
      return error(400, "WhatsApp spend is only available for Meta-connected businesses", origin);
    }

    const accessToken = business.accessToken;
    const phoneNumbers: PhoneNumber[] = business.phoneNumbers || [];
    const wabaIds = Array.from(new Set(phoneNumbers.map((pn) => pn.wabaid).filter((w): w is string => Boolean(w))));

    if (wabaIds.length === 0) {
      return error(400, "No WhatsApp Business Account is configured on this business's numbers", origin);
    }

    // MONTHLY (not DAILY) — the UI only shows a total per number, never a
    // day-by-day series — MONTHLY would be lighter, but Meta rejects it with
    // "Invalid parameter" for this field (confirmed against a real account),
    // so DAILY it is; the parallelization below is what actually fixes the
    // timeout, not the granularity.
    const perWabaResults = await Promise.all(
      wabaIds.map(async (wabaid) => {
        try {
          const url =
            `https://graph.facebook.com/v25.0/${wabaid}?fields=` +
            `pricing_analytics.start(${Math.floor(startMs / 1000)}).end(${Math.floor(endMs / 1000)})` +
            `.granularity(DAILY).dimensions(PHONE)`;
          const res = await fetchWithTimeout(url, accessToken, PER_WABA_TIMEOUT_MS);
          const data = (await res.json()) as { pricing_analytics?: { data?: PricingGroup[] }; error?: { message?: string } };

          if (data.error) {
            console.log(`[whatsapp-spend] wabaid=${wabaid} httpStatus=${res.status} metaError=${JSON.stringify(data.error)}`);
            return { wabaid, error: data.error.message || "Meta returned an error", points: [] as PricingDataPoint[] };
          }

          const points = (data.pricing_analytics?.data || []).flatMap((group) => group.data_points || []);
          console.log(`[whatsapp-spend] wabaid=${wabaid} httpStatus=${res.status} groups=${data.pricing_analytics?.data?.length || 0} points=${points.length}`);
          return { wabaid, error: null as string | null, points };
        } catch (err) {
          const message =
            err instanceof Error && err.name === "AbortError"
              ? `Timed out after ${PER_WABA_TIMEOUT_MS / 1000}s`
              : err instanceof Error
              ? err.message
              : "Request failed";
          console.log(`[whatsapp-spend] wabaid=${wabaid} threw: ${message}`);
          return { wabaid, error: message, points: [] as PricingDataPoint[] };
        }
      })
    );

    const perNumber = new Map<string, { cost: number; volume: number }>();
    const unmatched: { phone: string; cost: number; volume: number }[] = [];
    const fetchErrors: { wabaid: string; message: string }[] = [];

    for (const result of perWabaResults) {
      if (result.error) {
        fetchErrors.push({ wabaid: result.wabaid, message: result.error });
        continue;
      }
      for (const point of result.points) {
        const cost = point.cost || 0;
        const volume = point.volume || 0;
        const digits = point.phone_number ? digitsOnly(point.phone_number) : "";
        const matchedNumber = digits
          ? phoneNumbers.find((pn) => digitsOnly(pn.displayNumber).endsWith(digits) || digits.endsWith(digitsOnly(pn.displayNumber)))
          : undefined;

        if (matchedNumber) {
          const prev = perNumber.get(matchedNumber.phoneNumberId) || { cost: 0, volume: 0 };
          perNumber.set(matchedNumber.phoneNumberId, { cost: prev.cost + cost, volume: prev.volume + volume });
        } else {
          unmatched.push({ phone: point.phone_number || "unknown", cost, volume });
        }
      }
    }

    const byNumber = phoneNumbers
      .filter((pn) => pn.wabaid)
      .map((pn) => {
        const totals = perNumber.get(pn.phoneNumberId) || { cost: 0, volume: 0 };
        return {
          phoneNumberId: pn.phoneNumberId,
          displayNumber: pn.displayNumber,
          displayName: pn.displayName,
          wabaid: pn.wabaid,
          cost: Math.round(totals.cost * 100) / 100,
          volume: totals.volume,
        };
      });

    const totalCost = byNumber.reduce((sum, n) => sum + n.cost, 0) + unmatched.reduce((sum, u) => sum + u.cost, 0);
    const totalVolume = byNumber.reduce((sum, n) => sum + n.volume, 0) + unmatched.reduce((sum, u) => sum + u.volume, 0);

    return success(
      {
        businessId,
        businessName: business.businessName,
        // Meta's pricing_analytics doesn't return a currency code per data
        // point — cost comes back in whatever currency the WABA is billed
        // in. Every business in this app is India-based, so INR is a safe
        // assumption here, not something actually read off the response.
        currency: "INR",
        dateFrom: dateFrom || new Date(startMs).toISOString().slice(0, 10),
        dateTo: dateTo || new Date(endMs).toISOString().slice(0, 10),
        totalCost: Math.round(totalCost * 100) / 100,
        totalVolume,
        byNumber,
        unmatched,
        errors: fetchErrors,
      },
      origin
    );
  } catch (err) {
    console.error("WhatsApp spend error:", err);
    return error(500, "Failed to fetch WhatsApp spend", origin);
  }
};
