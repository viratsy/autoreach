import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const REENGAGEMENT_TABLE = process.env.REENGAGEMENT_TABLE!;

const WS_SHORT: Record<string, string> = {
  "generative ai tools": "aitools",
  "3 hour live generative ai tools workshop": "aitools",
  "ms office with ai": "msai",
  "3 hour live ms office with ai workshop": "msai",
  "ai builder": "aibuild",
  "3 hour live ai builder workshop": "aibuild",
  "ai builders": "aibuild",
  "ai dashboard": "aidash",
  "3 hour live ai dashboard workshop": "aidash",
};

function getWsCode(name: string): string {
  const key = (name || "").trim().toLowerCase();
  if (WS_SHORT[key]) return WS_SHORT[key];
  if (key.includes("generative ai") || key.includes("ai tools")) return "aitools";
  if (key.includes("ms office")) return "msai";
  if (key.includes("ai builder")) return "aibuild";
  if (key.includes("ai dashboard")) return "aidash";
  return key.replace(/[^a-z0-9]/g, "").slice(0, 8) || "ws";
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Bulk register contacts for workshop re-engagement.
 * POST /workshops/bulk-register
 * { contacts: [{name, phone, email}], workshopName, mode: "current" | "next" }
 * 
 * current: status=waiting, counter=0 (will enter funnel after their batch ends)
 * next: status=active, counter=1 (will be picked up by nightly scheduler for next batch)
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const body = JSON.parse(event.body || "{}");
    const { contacts, workshopName, mode } = body;

    if (!contacts?.length || !workshopName) {
      return error(400, "contacts array and workshopName are required", origin);
    }

    if (!["current", "next"].includes(mode)) {
      return error(400, "mode must be 'current' or 'next'", origin);
    }

    const wsCode = getWsCode(workshopName);
    const now = new Date().toISOString();
    let added = 0;
    let skipped = 0;

    for (const contact of contacts) {
      const phone = normalizePhone(contact.phone || "");
      if (!phone) { skipped++; continue; }

      const item: Record<string, unknown> = {
        PK: `PHONE#${phone}`,
        SK: `WS#${wsCode}`,
        GSI1PK: mode === "current" ? "STATUS#waiting" : "STATUS#active",
        GSI1SK: `WS#${wsCode}#PHONE#${phone}`,
        name: contact.name || "",
        phone,
        email: (contact.email || "").toLowerCase().trim(),
        workshopName,
        wsCode,
        counter: mode === "current" ? 0 : 1,
        status: mode === "current" ? "waiting" : "active",
        firstBatchDate: contact.workshop_date || "",
        lastBatchDate: "",
        registeredAt: now,
      };

      try {
        await docClient.send(
          new PutCommand({
            TableName: REENGAGEMENT_TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(PK)",
          })
        );
        added++;
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
          skipped++; // Already exists
        } else {
          throw err;
        }
      }
    }

    return success({ message: `Bulk register complete`, added, skipped, total: contacts.length, wsCode }, origin);
  } catch (err) {
    console.error("Bulk register error:", err);
    return error(500, "Failed to bulk register", origin);
  }
};
