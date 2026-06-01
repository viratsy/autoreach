import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const CONFIG_TABLE = process.env.WORKSHOP_CONFIG_TABLE || "autoreach-workshop-config-hardik";

/**
 * Workshop config CRUD.
 * GET /workshops/config?wsCode=aitools&cycle=0 → get specific config
 * GET /workshops/config/list → list all configs
 * PUT /workshops/config → save/update config
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  const path = event.path || "";

  // GET /workshops/config/list
  if (event.httpMethod === "GET" && path.includes("/list")) {
    return listConfigs(origin);
  }

  // GET /workshops/config?wsCode=x&cycle=0
  if (event.httpMethod === "GET") {
    return getConfig(event, origin);
  }

  // PUT /workshops/config
  if (event.httpMethod === "PUT") {
    return saveConfig(event, origin);
  }

  return error(405, "Method not allowed", origin);
};

async function listConfigs(origin?: string) {
  try {
    const result = await docClient.send(new ScanCommand({ TableName: CONFIG_TABLE }));
    const configs = (result.Items || []).map((item) => ({
      wsCode: item.wsCode,
      workshopName: item.workshopName,
      cycle: item.cycle,
      businessId: item.businessId,
      numberCount: Object.keys(item.numbers || {}).length,
      runKeyCount: Object.keys(item.runKeys || {}).length,
    }));
    return success({ configs }, origin);
  } catch (err) {
    console.error("List configs error:", err);
    return error(500, "Failed to list configs", origin);
  }
}

async function getConfig(event: { queryStringParameters?: Record<string, string | undefined> | null }, origin?: string) {
  try {
    const wsCode = event.queryStringParameters?.wsCode;
    const cycle = event.queryStringParameters?.cycle || "0";

    if (!wsCode) return error(400, "wsCode is required", origin);

    const result = await docClient.send(
      new GetCommand({
        TableName: CONFIG_TABLE,
        Key: { PK: `WSCONFIG#${wsCode}`, SK: `CYCLE#${cycle}` },
      })
    );

    if (!result.Item) return success({ config: null }, origin);

    return success({ config: result.Item }, origin);
  } catch (err) {
    console.error("Get config error:", err);
    return error(500, "Failed to get config", origin);
  }
}

async function saveConfig(event: { body?: string | null }, origin?: string) {
  try {
    const body = JSON.parse(event.body || "{}");
    const { wsCode, workshopName, cycle, businessId, numbers, runKeys, customParams, activeRunKeys } = body;

    if (!wsCode || cycle === undefined) {
      return error(400, "wsCode and cycle are required", origin);
    }

    const item = {
      PK: `WSCONFIG#${wsCode}`,
      SK: `CYCLE#${cycle}`,
      wsCode,
      workshopName: workshopName || "",
      cycle: Number(cycle),
      businessId: businessId || "",
      numbers: numbers || {},
      runKeys: runKeys || {},
      customParams: customParams || {},
      activeRunKeys: activeRunKeys || undefined,
      updatedAt: new Date().toISOString(),
    };

    await docClient.send(new PutCommand({ TableName: CONFIG_TABLE, Item: item }));

    return success({ message: "Config saved", wsCode, cycle }, origin);
  } catch (err) {
    console.error("Save config error:", err);
    return error(500, "Failed to save config", origin);
  }
}
