import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { MonthlyCost } from "../../lib/aws-cost";
import { STATUS_KEY } from "./compute";

const TABLE = process.env.BILLING_TABLE!;

/**
 * Returns the cached monthly snapshots, newest first.
 * GET /billing
 *
 * Reads the cache only — Cost Explorer charges per query, so recomputing is
 * deliberately kept to the daily schedule and the explicit refresh button.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    // One row per month plus the status row — a scan stays trivial for years.
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await docClient.send(
        new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey })
      );
      items.push(...((res.Items || []) as Record<string, unknown>[]));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);

    const statusRow = items.find((i) => i.month === STATUS_KEY);
    const months = items
      .filter((i) => i.month !== STATUS_KEY)
      .sort((a, b) => String(b.month).localeCompare(String(a.month))) as unknown as MonthlyCost[];

    return success({ months, status: statusRow?.status || null }, origin);
  } catch (err) {
    console.error("[billing] get failed", err);
    return error(500, err instanceof Error ? err.message : "Failed to load billing", origin);
  }
};
