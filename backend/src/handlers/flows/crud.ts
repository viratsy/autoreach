import { APIGatewayProxyHandler } from "aws-lambda";
import {
  PutCommand,
  QueryCommand,
  DeleteCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { FlowRecord, FlowStep } from "../../lib/flow-types";

const FLOWS_TABLE = process.env.FLOWS_TABLE!;

/**
 * GET /flows?businessId=xxx — List all flows
 * POST /flows — Create a flow
 * PUT /flows/{flowId} — Update a flow
 * DELETE /flows/{flowId} — Delete a flow
 * POST /flows/{flowId}/toggle — Toggle active/paused
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  const path = event.path;
  const method = event.httpMethod;

  // POST /flows/{flowId}/toggle
  if (method === "POST" && path.includes("/toggle")) {
    return toggleFlow(event, origin);
  }

  // GET /flows
  if (method === "GET" && !event.pathParameters?.flowId) {
    return listFlows(event, origin);
  }

  // GET /flows/{flowId}
  if (method === "GET" && event.pathParameters?.flowId) {
    return getFlow(event, origin);
  }

  // POST /flows
  if (method === "POST" && !event.pathParameters?.flowId) {
    return createFlow(event, origin);
  }

  // PUT /flows/{flowId}
  if (method === "PUT") {
    return updateFlow(event, origin);
  }

  // DELETE /flows/{flowId}
  if (method === "DELETE") {
    return deleteFlow(event, origin);
  }

  return error(405, "Method not allowed", origin);
};

async function listFlows(event: any, origin?: string) {
  const businessId = event.queryStringParameters?.businessId;
  if (!businessId) return error(400, "businessId required", origin);

  const result = await docClient.send(
    new QueryCommand({
      TableName: FLOWS_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": `BIZ#${businessId}`,
        ":sk": "FLOW#",
      },
    })
  );

  return success({ flows: result.Items || [] }, origin);
}

async function getFlow(event: any, origin?: string) {
  const flowId = event.pathParameters?.flowId;
  const businessId = event.queryStringParameters?.businessId;
  if (!flowId || !businessId) return error(400, "flowId and businessId required", origin);

  const result = await docClient.send(
    new GetCommand({
      TableName: FLOWS_TABLE,
      Key: { PK: `BIZ#${businessId}`, SK: `FLOW#${flowId}` },
    })
  );

  if (!result.Item) return error(404, "Flow not found", origin);
  return success({ flow: result.Item }, origin);
}

async function createFlow(event: any, origin?: string) {
  const body = JSON.parse(event.body || "{}");
  const { businessId, phoneNumberId, flowName, triggerKeywords, triggerType, steps } = body;

  if (!businessId || !flowName || !triggerKeywords?.length) {
    return error(400, "businessId, flowName, triggerKeywords required", origin);
  }

  const flowId = `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  const item: FlowRecord = {
    PK: `BIZ#${businessId}`,
    SK: `FLOW#${flowId}`,
    flowId,
    flowName,
    businessId,
    phoneNumberId: phoneNumberId || "",
    triggerKeywords: triggerKeywords.map((k: string) => k.toLowerCase().trim()),
    triggerType: triggerType || "keyword_match",
    steps: (steps || []) as FlowStep[],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: FLOWS_TABLE, Item: item }));
  return success({ flow: item }, origin);
}

async function updateFlow(event: any, origin?: string) {
  const flowId = event.pathParameters?.flowId;
  const body = JSON.parse(event.body || "{}");
  const { businessId, flowName, triggerKeywords, triggerType, steps, phoneNumberId } = body;

  if (!flowId || !businessId) return error(400, "flowId and businessId required", origin);

  const now = new Date().toISOString();
  const updateParts: string[] = ["updatedAt = :now"];
  const values: Record<string, unknown> = { ":now": now };

  if (flowName) {
    updateParts.push("flowName = :fn");
    values[":fn"] = flowName;
  }
  if (triggerKeywords) {
    updateParts.push("triggerKeywords = :tk");
    values[":tk"] = triggerKeywords.map((k: string) => k.toLowerCase().trim());
  }
  if (triggerType) {
    updateParts.push("triggerType = :tt");
    values[":tt"] = triggerType;
  }
  if (steps) {
    updateParts.push("steps = :st");
    values[":st"] = steps;
  }
  if (phoneNumberId) {
    updateParts.push("phoneNumberId = :pn");
    values[":pn"] = phoneNumberId;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: FLOWS_TABLE,
      Key: { PK: `BIZ#${businessId}`, SK: `FLOW#${flowId}` },
      UpdateExpression: `SET ${updateParts.join(", ")}`,
      ExpressionAttributeValues: values,
    })
  );

  return success({ message: "Flow updated" }, origin);
}

async function deleteFlow(event: any, origin?: string) {
  const flowId = event.pathParameters?.flowId;
  const businessId = event.queryStringParameters?.businessId;
  if (!flowId || !businessId) return error(400, "flowId and businessId required", origin);

  await docClient.send(
    new DeleteCommand({
      TableName: FLOWS_TABLE,
      Key: { PK: `BIZ#${businessId}`, SK: `FLOW#${flowId}` },
    })
  );

  return success({ message: "Flow deleted" }, origin);
}

async function toggleFlow(event: any, origin?: string) {
  const flowId = event.pathParameters?.flowId;
  const body = JSON.parse(event.body || "{}");
  const { businessId } = body;
  if (!flowId || !businessId) return error(400, "flowId and businessId required", origin);

  const current = await docClient.send(
    new GetCommand({
      TableName: FLOWS_TABLE,
      Key: { PK: `BIZ#${businessId}`, SK: `FLOW#${flowId}` },
    })
  );

  if (!current.Item) return error(404, "Flow not found", origin);

  const newStatus = current.Item.status === "active" ? "paused" : "active";

  await docClient.send(
    new UpdateCommand({
      TableName: FLOWS_TABLE,
      Key: { PK: `BIZ#${businessId}`, SK: `FLOW#${flowId}` },
      UpdateExpression: "SET #status = :s, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":s": newStatus, ":now": new Date().toISOString() },
    })
  );

  return success({ status: newStatus }, origin);
}
