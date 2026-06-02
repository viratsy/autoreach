import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const REGISTRY_TABLE = process.env.WORKSHOP_REGISTRY_TABLE || "autoreach-workshop-registry-hardik";

/**
 * Workshop Registry CRUD.
 * GET /workshops/registry → list all workshops
 * PUT /workshops/registry → create/update a workshop
 * DELETE /workshops/registry?code=xxx → delete a workshop
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  if (event.httpMethod === "GET") {
    try {
      const result = await ScanCommand ? await docClient.send(new ScanCommand({ TableName: REGISTRY_TABLE })) : { Items: [] };
      return success({ workshops: result.Items || [] }, origin);
    } catch (err) {
      console.error("List registry error:", err);
      return error(500, "Failed to list workshops", origin);
    }
  }

  if (event.httpMethod === "PUT") {
    try {
      const body = JSON.parse(event.body || "{}");
      const { code, displayName, aliases, time, runKeys, mentorName } = body;

      if (!code) return error(400, "code is required", origin);

      const item = {
        PK: `WORKSHOP#${code}`,
        SK: "METADATA",
        code,
        displayName: displayName || code,
        aliases: aliases || [],
        time: time || "7pm",
        runKeys: runKeys || [],
        mentorName: mentorName || "",
        updatedAt: new Date().toISOString(),
      };

      await docClient.send(new PutCommand({ TableName: REGISTRY_TABLE, Item: item }));
      return success({ message: "Workshop saved", code }, origin);
    } catch (err) {
      console.error("Save registry error:", err);
      return error(500, "Failed to save workshop", origin);
    }
  }

  if (event.httpMethod === "DELETE") {
    const code = event.queryStringParameters?.code;
    if (!code) return error(400, "code is required", origin);
    try {
      await docClient.send(new DeleteCommand({ TableName: REGISTRY_TABLE, Key: { PK: `WORKSHOP#${code}`, SK: "METADATA" } }));
      return success({ message: "Deleted" }, origin);
    } catch (err) {
      console.error("Delete registry error:", err);
      return error(500, "Failed to delete", origin);
    }
  }

  return error(405, "Method not allowed", origin);
};
