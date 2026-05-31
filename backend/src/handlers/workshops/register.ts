import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const REENGAGEMENT_TABLE = process.env.REENGAGEMENT_TABLE!;

// Workshop short codes
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
  // Try partial match
  if (key.includes("generative ai") || key.includes("ai tools")) return "aitools";
  if (key.includes("ms office")) return "msai";
  if (key.includes("ai builder")) return "aibuild";
  if (key.includes("ai dashboard")) return "aidash";
  // Fallback: first 8 chars alphanumeric
  return key.replace(/[^a-z0-9]/g, "").slice(0, 8) || "ws";
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Register a contact for workshop re-engagement.
 * POST /workshops/register
 * { name, phone, email, workshop_name }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const body = JSON.parse(event.body || "{}");
    const { name, phone, email, workshop_name } = body;

    if (!phone || !workshop_name) {
      return error(400, "phone and workshop_name are required", origin);
    }

    const digits = normalizePhone(phone);
    const wsCode = getWsCode(workshop_name);
    const now = new Date().toISOString();

    const item = {
      PK: `PHONE#${digits}`,
      SK: `WS#${wsCode}`,
      GSI1PK: "STATUS#active",
      GSI1SK: `WS#${wsCode}#PHONE#${digits}`,
      name: name || "",
      phone: digits,
      email: (email || "").toLowerCase().trim(),
      workshopName: workshop_name,
      wsCode,
      counter: 0,
      status: "active",
      lastBatchDate: "",
      registeredAt: now,
    };

    // Idempotent: only create if doesn't exist
    try {
      await docClient.send(
        new PutCommand({
          TableName: REENGAGEMENT_TABLE,
          Item: item,
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        // Already exists - that's fine
        return success({ message: "Contact already registered", wsCode }, origin);
      }
      throw err;
    }

    return success({ message: "Contact registered for re-engagement", wsCode, phone: digits }, origin);
  } catch (err) {
    console.error("Register error:", err);
    return error(500, "Failed to register contact", origin);
  }
};
