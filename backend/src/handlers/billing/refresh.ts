import { APIGatewayProxyHandler } from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { currentMonth, previousMonth } from "../../lib/aws-cost";
import { STATUS_KEY } from "./compute";

const lambda = new LambdaClient({});
const TABLE = process.env.BILLING_TABLE!;
const COMPUTE_FUNCTION = process.env.BILLING_COMPUTE_FUNCTION!;

/** A run that started this long ago is treated as dead rather than in flight. */
const STALE_RUN_MS = 15 * 60 * 1000;

/**
 * Kicks off a recompute and returns immediately.
 * POST /billing/refresh   body: { months?: ["2026-08"] }
 *
 * The work takes minutes, well past API Gateway's 29s ceiling, so this fires the
 * compute function asynchronously and the page polls GET /billing until the
 * status row reports it finished.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const requested: unknown = body.months;

    const months =
      Array.isArray(requested) && requested.length
        ? requested.filter((m): m is string => typeof m === "string" && /^\d{4}-\d{2}$/.test(m))
        : [currentMonth(), previousMonth()];

    if (!months.length) return error(400, "months must be YYYY-MM strings", origin);

    // Each Cost Explorer query is billed, and a full run is minutes of metric
    // reads — so don't stack runs if one is already going.
    const statusRow = await docClient.send(new GetCommand({ TableName: TABLE, Key: { month: STATUS_KEY } }));
    const status = statusRow.Item?.status as { running?: boolean; startedAt?: string } | undefined;
    if (status?.running && status.startedAt) {
      const age = Date.now() - new Date(status.startedAt).getTime();
      if (age < STALE_RUN_MS) {
        return success({ started: false, alreadyRunning: true, months }, origin);
      }
    }

    await lambda.send(
      new InvokeCommand({
        FunctionName: COMPUTE_FUNCTION,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ months })),
      })
    );

    return success({ started: true, months }, origin);
  } catch (err) {
    console.error("[billing] refresh failed", err);
    return error(500, err instanceof Error ? err.message : "Failed to start refresh", origin);
  }
};
