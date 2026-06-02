import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const REENGAGEMENT_TABLE = process.env.REENGAGEMENT_TABLE!;
const REGISTRY_TABLE = process.env.WORKSHOP_REGISTRY_TABLE || "autoreach-workshop-registry-hardik";

// Cache registry in memory (Lambda warm start)
let registryCache: { code: string; aliases: string[] }[] | null = null;
let registryCacheTime = 0;

async function loadRegistry() {
  const now = Date.now();
  if (registryCache && now - registryCacheTime < 5 * 60 * 1000) return registryCache;
  try {
    const result = await docClient.send(new ScanCommand({ TableName: REGISTRY_TABLE }));
    registryCache = (result.Items || []).map((item) => ({ code: item.code, aliases: item.aliases || [] }));
    registryCacheTime = now;
  } catch {
    if (!registryCache) registryCache = [];
  }
  return registryCache;
}

async function getWsCode(name: string): Promise<string> {
  const registry = await loadRegistry();
  const key = (name || "").trim().toLowerCase();
  
  // Exact match on code
  const exactCode = registry.find((r) => r.code === key);
  if (exactCode) return exactCode.code;
  
  // Match on aliases
  for (const ws of registry) {
    for (const alias of ws.aliases) {
      if (alias.toLowerCase() === key) return ws.code;
    }
    // Partial match
    for (const alias of ws.aliases) {
      if (key.includes(alias.toLowerCase()) || alias.toLowerCase().includes(key)) return ws.code;
    }
  }
  
  // Fallback: first 8 chars
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
    const wsCode = await getWsCode(workshop_name);
    const now = new Date().toISOString();

    const item = {
      PK: `PHONE#${digits}`,
      SK: `WS#${wsCode}`,
      GSI1PK: "STATUS#waiting",
      GSI1SK: `WS#${wsCode}#PHONE#${digits}`,
      name: name || "",
      phone: digits,
      email: (email || "").toLowerCase().trim(),
      workshopName: workshop_name,
      wsCode,
      counter: 0,
      status: "waiting",
      firstBatchDate: body.workshop_date || "",
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
