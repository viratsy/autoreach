import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, ScanCommand, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { storeConversation } from "./execute";
import { getAuthEmail } from "../../lib/auth";

const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE!;
const FLOW_INSTANCES_TABLE = process.env.FLOW_INSTANCES_TABLE!;
const BUSINESSES_TABLE = process.env.BUSINESSES_TABLE!;

/**
 * GET /conversations?phone=xxx&phoneNumberId=yyy — Get chat history for a contact
 * GET /conversations/list?phoneNumberId=yyy — List recent conversations (unique contacts)
 * GET /flows/{flowId}/instances — List instances for a flow
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  const path = event.path;

  // GET /flows/{flowId}/instances
  if (path.includes("/instances")) {
    return listInstances(event, origin);
  }

  // GET /conversations/list
  if (path.includes("/conversations/list")) {
    return listConversations(event, origin);
  }

  // GET /conversations?phone=xxx&phoneNumberId=yyy
  if (event.httpMethod === "GET") {
    return getConversation(event, origin);
  }

  // POST /conversations/send
  if (event.httpMethod === "POST") {
    return sendConversation(event, origin);
  }

  return error(405, "Method not allowed", origin);
};

async function getConversation(event: any, origin?: string) {
  const phone = event.queryStringParameters?.phone;
  const phoneNumberId = event.queryStringParameters?.phoneNumberId;

  if (!phone || !phoneNumberId) {
    return error(400, "phone and phoneNumberId required", origin);
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: CONVERSATIONS_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `PHONE#${phone}#NUM#${phoneNumberId}`,
      },
      ScanIndexForward: true, // Oldest first (chronological)
      Limit: 200,
    })
  );

  return success({ messages: result.Items || [] }, origin);
}

async function listConversations(event: any, origin?: string) {
  const phoneNumberId = event.queryStringParameters?.phoneNumberId;
  if (!phoneNumberId) {
    return error(400, "phoneNumberId required", origin);
  }

  // Query GSI1 to get recent messages for this number
  const result = await docClient.send(
    new QueryCommand({
      TableName: CONVERSATIONS_TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `NUM#${phoneNumberId}` },
      ScanIndexForward: false, // Newest first
      Limit: 100,
    })
  );

  // Deduplicate by phone to get unique contacts with last message
  const contactMap = new Map<string, any>();
  for (const msg of result.Items || []) {
    if (!contactMap.has(msg.phone)) {
      contactMap.set(msg.phone, {
        phone: msg.phone,
        name: msg.contactName || undefined,
        lastMessage: msg.content,
        lastDirection: msg.direction,
        lastTimestamp: msg.timestamp,
        phoneNumberId: msg.phoneNumberId,
      });
    }
  }

  const contacts = Array.from(contactMap.values()).slice(0, 50);
  return success({ contacts }, origin);
}

async function sendConversation(event: any, origin?: string) {
  const body = JSON.parse(event.body || "{}");
  const { businessId, phoneNumberId, phone, messageType, messageText, templateName, contactName, parameters } = body;

  if (!businessId || !phoneNumberId || !phone || !messageType) {
    return error(400, "businessId, phoneNumberId, phone, and messageType are required", origin);
  }

  const bizResult = await docClient.send(
    new GetCommand({ TableName: BUSINESSES_TABLE, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
  );

  const business = bizResult.Item;
  if (!business) {
    return error(404, "Business not found", origin);
  }

  const accessToken = business.accessToken || process.env.META_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`;
  let payload: Record<string, unknown>;

  if (messageType === "text") {
    if (!messageText) return error(400, "messageText is required for text messages", origin);
    payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: messageText },
    };
  } else if (messageType === "template") {
    if (!templateName) return error(400, "templateName is required for template messages", origin);
    const components: unknown[] = [];
    if (parameters && parameters.length > 0) {
      components.push({
        type: "body",
        parameters: parameters.map((p: string) => ({ type: "text", text: p })),
      });
    }
    payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en" },
        components: components.length > 0 ? components : undefined,
      },
    };
  } else {
    return error(400, "Unsupported messageType", origin);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json() as { error?: { message?: string }; messages?: { id: string }[] };
  if (!response.ok) {
    console.error("Failed to send WhatsApp message:", data);
    return error(500, data?.error?.message || "Failed to send message", origin);
  }

  const msgId = (data as { messages?: { id: string }[] }).messages?.[0]?.id || "";
  await storeConversation({
    phone,
    phoneNumberId,
    direction: "outbound",
    messageType: messageType === "text" ? "text" : "template",
    content: messageType === "text" ? messageText : templateName,
    metaMessageId: msgId,
    flowId: undefined,
    contactName,
    timestamp: new Date().toISOString(),
  });

  return success({ result: data, metaMessageId: msgId }, origin);
}

async function listInstances(event: any, origin?: string) {
  const flowId = event.pathParameters?.flowId;
  if (!flowId) return error(400, "flowId required", origin);

  const statusFilter = event.queryStringParameters?.status;

  let filterExpr = undefined;
  let exprValues: Record<string, unknown> = { ":pk": `FLOW#${flowId}` };

  if (statusFilter) {
    filterExpr = "#status = :sf";
    exprValues[":sf"] = statusFilter;
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: FLOW_INSTANCES_TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ...(filterExpr && {
        FilterExpression: filterExpr,
        ExpressionAttributeNames: { "#status": "status" },
      }),
      ExpressionAttributeValues: exprValues,
      ScanIndexForward: false,
      Limit: 100,
    })
  );

  return success({ instances: result.Items || [] }, origin);
}
