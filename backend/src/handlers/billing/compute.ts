import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { computeMonthlyCost, currentMonth, previousMonth } from "../../lib/aws-cost";

const TABLE = process.env.BILLING_TABLE!;
export const STATUS_KEY = "__STATUS__";

/**
 * Works out and stores AutoReach's share of the AWS bill.
 *
 * Never fronted by API Gateway: a full month takes well over the 29s API
 * timeout (it reads ~500 CloudWatch metrics). The refresh endpoint invokes this
 * asynchronously and the page polls for the result.
 *
 * Invoked by:
 *   - the daily schedule, with no payload
 *   - refresh.ts, with { months: ["2026-08"] }
 */
export const handler = async (event: { months?: string[] } = {}) => {
  const now = new Date();

  // The daily run always refreshes the month in progress. On the first few days
  // of a month it also (re)computes the one that just ended — once on the 1st
  // to get the number in front of people straight away, and again up to the 5th
  // because AWS keeps posting late charges (tax especially) after the month
  // closes, and only the later pass is marked final.
  const months = event.months?.length
    ? event.months
    : now.getUTCDate() <= 5
      ? [currentMonth(now), previousMonth(now)]
      : [currentMonth(now)];

  await setStatus({ running: true, startedAt: now.toISOString(), months });

  const done: string[] = [];
  const failed: { month: string; message: string }[] = [];

  for (const month of months) {
    try {
      const snapshot = await computeMonthlyCost(month, now);
      await docClient.send(new PutCommand({ TableName: TABLE, Item: snapshot }));
      done.push(month);
      console.log(
        `[billing] ${month} account=$${snapshot.accountTotal.toFixed(2)} ` +
          `autoreach=$${snapshot.autoreachTotal.toFixed(2)} (${snapshot.autoreachPercent.toFixed(0)}%) final=${snapshot.final}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[billing] ${month} failed: ${message}`);
      failed.push({ month, message });
    }
  }

  await setStatus({
    running: false,
    finishedAt: new Date().toISOString(),
    months,
    computed: done,
    failed,
  });

  return { computed: done, failed };
};

/**
 * Kept in the same table under a reserved month key so the page can show
 * "refreshing…" without a second store to read.
 */
async function setStatus(status: Record<string, unknown>) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { month: STATUS_KEY },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": status },
      })
    );
  } catch (err) {
    // A status write failing must not lose a computed snapshot.
    console.error("[billing] status write failed", err);
  }
}
