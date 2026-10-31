import { APIGatewayProxyHandler } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { getTestNumbers, TestNumber, TEST_NUMBERS_KEY } from "../../lib/test-numbers";

const CONFIG_TABLE = process.env.WORKSHOP_CONFIG_TABLE || "autoreach-workshop-config-hardik";

/**
 * The shared QA/team number list that rides along in every Crossale and
 * current-batch audience (see lib/test-numbers.ts) — one list per AWS account.
 *
 * GET    /workshops/test-numbers → list
 * POST   /workshops/test-numbers → append { name, phone }
 * DELETE /workshops/test-numbers → remove { phone }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    if (event.httpMethod === "GET") {
      return success({ testNumbers: await getTestNumbers() }, origin);
    }

    const body = JSON.parse(event.body || "{}") as { name?: string; phone?: string };
    // Digits only, so the same number typed as +91 90293 09137 matches the
    // stored 919029309137 rather than being added a second time.
    const phone = (body.phone || "").replace(/\D/g, "");

    if (event.httpMethod === "DELETE") {
      if (!phone) return error(400, "phone is required", origin);
      const remaining = (await getTestNumbers()).filter((n) => n.phone !== phone);
      const result = await docClient.send(
        new UpdateCommand({
          TableName: CONFIG_TABLE,
          Key: TEST_NUMBERS_KEY,
          UpdateExpression: "SET testNumbers = :list, updatedAt = :now",
          ExpressionAttributeValues: { ":list": remaining, ":now": new Date().toISOString() },
          ReturnValues: "ALL_NEW",
        })
      );
      return success({ testNumbers: result.Attributes?.testNumbers || [] }, origin);
    }

    if (event.httpMethod === "POST") {
      const name = (body.name || "").trim();
      if (!name || !phone) return error(400, "name and phone are required", origin);

      const existing = await getTestNumbers();
      if (existing.some((n) => n.phone === phone)) {
        return success({ testNumbers: existing }, origin);
      }

      const entry: TestNumber = { name, phone };
      const result = await docClient.send(
        new UpdateCommand({
          TableName: CONFIG_TABLE,
          Key: TEST_NUMBERS_KEY,
          UpdateExpression:
            "SET testNumbers = list_append(if_not_exists(testNumbers, :empty), :new), updatedAt = :now",
          ExpressionAttributeValues: { ":empty": [], ":new": [entry], ":now": new Date().toISOString() },
          ReturnValues: "ALL_NEW",
        })
      );
      return success({ testNumbers: result.Attributes?.testNumbers || [] }, origin);
    }

    return error(405, "Method not allowed", origin);
  } catch (err) {
    console.error("[test-numbers] failed", err);
    return error(500, err instanceof Error ? err.message : "Failed", origin);
  }
};
