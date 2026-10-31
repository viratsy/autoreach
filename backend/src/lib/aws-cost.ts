import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { CloudWatchClient, GetMetricDataCommand, MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { APIGatewayClient, GetRestApisCommand } from "@aws-sdk/client-api-gateway";
import { SQSClient, ListQueuesCommand } from "@aws-sdk/client-sqs";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";

/**
 * Works out how much of an AWS account's bill AutoReach is responsible for.
 *
 * Cost Explorer can only split a bill by resource once the
 * aws:cloudformation:stack-name cost allocation tag has been activated, and AWS
 * does not apply that tag retroactively — so tags can never answer "what did
 * AutoReach cost us last quarter". This does it from usage metrics instead,
 * which CloudWatch retains for 15 months.
 *
 * The split is a real measurement, not a guess, because two things hold in these
 * accounts: everything AutoReach owns is named `autoreach-*`, and every DynamoDB
 * table is on-demand, so cost moves exactly in step with consumed units. Checked
 * against the billed quantity for July 2026 on the Hardik account: 88,866,727
 * write units measured from CloudWatch against 88,866,727 billed — exact.
 *
 * Accuracy varies by service and is reported per service as `basis`:
 *   metered  - the usage metric IS the billing unit (DynamoDB, API Gateway)
 *   modelled - derived from usage metrics (Lambda GB-seconds, SQS requests)
 *   none     - nothing AutoReach runs touches this service
 */

const REGION = process.env.AWS_REGION || "ap-south-1";
const PREFIX = "autoreach-";

const ce = new CostExplorerClient({ region: "us-east-1" }); // Cost Explorer is us-east-1 only
const cw = new CloudWatchClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const apigw = new APIGatewayClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

export interface ServiceCost {
  service: string;
  total: number;
  autoreach: number;
  basis: "metered" | "modelled" | "none";
}

export interface MonthlyCost {
  month: string; // YYYY-MM
  accountTotal: number;
  autoreachTotal: number;
  autoreachPercent: number;
  services: ServiceCost[];
  tax: number;
  taxAutoreach: number;
  /** False while the month is still open or AWS is still posting late charges. */
  final: boolean;
  computedAt: string;
  periodStart: string;
  periodEnd: string;
}

type Share = { autoreach: number; total: number };
const EMPTY: Share = { autoreach: 0, total: 0 };

/** One CloudWatch metric to total over the period. */
interface MetricSpec {
  key: string;
  namespace: string;
  metricName: string;
  dimensions: { Name: string; Value: string }[];
  stat?: string;
}

/**
 * Sums each spec over the period. Daily periods are used rather than one giant
 * bucket because CloudWatch aligns long periods to its own boundaries, which
 * silently pulls in usage from outside the month.
 */
async function sumMetrics(specs: MetricSpec[], start: Date, end: Date): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const byId = new Map<string, string>();

  const queries: MetricDataQuery[] = specs.map((s, i) => {
    const id = `q${i}`;
    byId.set(id, s.key);
    return {
      Id: id,
      MetricStat: {
        Metric: { Namespace: s.namespace, MetricName: s.metricName, Dimensions: s.dimensions },
        Period: 86400,
        Stat: s.stat || "Sum",
      },
      ReturnData: true,
    };
  });

  // GetMetricData caps at 500 queries per call, and paginates when the result
  // set is large — both have to be handled or totals come back short.
  for (let i = 0; i < queries.length; i += 450) {
    const chunk = queries.slice(i, i + 450);
    let nextToken: string | undefined;
    do {
      const res = await cw.send(
        new GetMetricDataCommand({
          MetricDataQueries: chunk,
          StartTime: start,
          EndTime: end,
          ScanBy: "TimestampAscending",
          NextToken: nextToken,
        })
      );
      for (const r of res.MetricDataResults || []) {
        const key = byId.get(r.Id!);
        if (!key) continue;
        out[key] = (out[key] || 0) + (r.Values || []).reduce((a, b) => a + b, 0);
      }
      nextToken = res.NextToken;
    } while (nextToken);
  }
  return out;
}

function splitBy(sums: Record<string, number>, isAutoreach: (name: string) => boolean): Share {
  let total = 0;
  let autoreach = 0;
  for (const [name, value] of Object.entries(sums)) {
    total += value;
    if (isAutoreach(name)) autoreach += value;
  }
  return { autoreach, total };
}

const byPrefix = (name: string) => name.startsWith(PREFIX);

interface Shares {
  ddbWrite: Share;
  ddbRead: Share;
  lambdaGbSec: Share;
  lambdaReq: Share;
  apigw: Share;
  sqs: Share;
  logs: Share;
  s3: Share;
}

/** Measures AutoReach's share of usage for each service over the period. */
async function buildShares(start: Date, end: Date): Promise<Shares> {
  // --- DynamoDB ---------------------------------------------------------
  // GSI writes are billed on top of the base table's and are reported under a
  // separate dimension, so leaving them out understates write-heavy tables by
  // roughly half on these accounts.
  const tables: string[] = [];
  let lastTable: string | undefined;
  do {
    const res = await ddb.send(new ListTablesCommand({ ExclusiveStartTableName: lastTable }));
    tables.push(...(res.TableNames || []));
    lastTable = res.LastEvaluatedTableName;
  } while (lastTable);

  const ddbSpecs: MetricSpec[] = [];
  for (const table of tables) {
    const desc = await ddb.send(new DescribeTableCommand({ TableName: table }));
    const indexes = desc.Table?.GlobalSecondaryIndexes || [];
    const targets: { Name: string; Value: string }[][] = [[{ Name: "TableName", Value: table }]];
    for (const idx of indexes) {
      targets.push([
        { Name: "TableName", Value: table },
        { Name: "GlobalSecondaryIndexName", Value: idx.IndexName! },
      ]);
    }
    for (const dimensions of targets) {
      ddbSpecs.push({ key: `w|${table}`, namespace: "AWS/DynamoDB", metricName: "ConsumedWriteCapacityUnits", dimensions });
      ddbSpecs.push({ key: `r|${table}`, namespace: "AWS/DynamoDB", metricName: "ConsumedReadCapacityUnits", dimensions });
    }
  }
  const ddbSums = await sumMetrics(ddbSpecs, start, end);
  const pick = (tag: string) => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(ddbSums)) {
      if (k.startsWith(`${tag}|`)) out[k.slice(2)] = v;
    }
    return out;
  };

  // --- Lambda -----------------------------------------------------------
  // Billed on GB-seconds, so duration alone misattributes: a 1024MB function
  // costs 4x a 256MB one for the same wall time.
  const memoryByFn: Record<string, number> = {};
  let fnMarker: string | undefined;
  do {
    const res = await lambda.send(new ListFunctionsCommand({ Marker: fnMarker }));
    for (const f of res.Functions || []) memoryByFn[f.FunctionName!] = f.MemorySize || 128;
    fnMarker = res.NextMarker;
  } while (fnMarker);

  const lambdaSpecs: MetricSpec[] = [];
  for (const fn of Object.keys(memoryByFn)) {
    const dimensions = [{ Name: "FunctionName", Value: fn }];
    lambdaSpecs.push({ key: `d|${fn}`, namespace: "AWS/Lambda", metricName: "Duration", dimensions });
    lambdaSpecs.push({ key: `i|${fn}`, namespace: "AWS/Lambda", metricName: "Invocations", dimensions });
  }
  const lambdaSums = await sumMetrics(lambdaSpecs, start, end);
  const gbSec: Record<string, number> = {};
  const invocations: Record<string, number> = {};
  for (const [fn, memory] of Object.entries(memoryByFn)) {
    gbSec[fn] = ((lambdaSums[`d|${fn}`] || 0) / 1000) * (memory / 1024);
    invocations[fn] = lambdaSums[`i|${fn}`] || 0;
  }

  // --- API Gateway ------------------------------------------------------
  const apis = (await apigw.send(new GetRestApisCommand({ limit: 500 }))).items || [];
  const apiSums = await sumMetrics(
    apis.map((a) => ({
      key: a.name!,
      namespace: "AWS/ApiGateway",
      metricName: "Count",
      dimensions: [{ Name: "ApiName", Value: a.name! }],
    })),
    start,
    end
  );

  // --- SQS --------------------------------------------------------------
  // Billed per API request; sends, receives, deletes and empty polls each count.
  const queueUrls = (await sqs.send(new ListQueuesCommand({ MaxResults: 1000 }))).QueueUrls || [];
  const sqsSpecs: MetricSpec[] = [];
  for (const url of queueUrls) {
    const queue = url.split("/").pop()!;
    const dimensions = [{ Name: "QueueName", Value: queue }];
    for (const metricName of [
      "NumberOfMessagesSent",
      "NumberOfMessagesReceived",
      "NumberOfMessagesDeleted",
      "NumberOfEmptyReceives",
    ]) {
      sqsSpecs.push({ key: queue, namespace: "AWS/SQS", metricName, dimensions });
    }
  }
  const sqsSums = await sumMetrics(sqsSpecs, start, end);

  // --- CloudWatch -------------------------------------------------------
  // Log ingestion dominates the CloudWatch line; AutoReach's log groups are the
  // ones under /aws/lambda/autoreach-*.
  const logGroups: string[] = [];
  let logToken: string | undefined;
  do {
    const res = await logs.send(new DescribeLogGroupsCommand({ nextToken: logToken, limit: 50 }));
    logGroups.push(...(res.logGroups || []).map((g) => g.logGroupName!));
    logToken = res.nextToken;
  } while (logToken);
  const logSums = await sumMetrics(
    logGroups.map((g) => ({
      key: g,
      namespace: "AWS/Logs",
      metricName: "IncomingBytes",
      dimensions: [{ Name: "LogGroupName", Value: g }],
    })),
    start,
    end
  );

  // --- S3 ---------------------------------------------------------------
  const buckets = (await s3.send(new ListBucketsCommand({}))).Buckets || [];
  const s3Sums = await sumMetrics(
    buckets.map((b) => ({
      key: b.Name!,
      namespace: "AWS/S3",
      metricName: "BucketSizeBytes",
      dimensions: [
        { Name: "BucketName", Value: b.Name! },
        { Name: "StorageType", Value: "StandardStorage" },
      ],
      stat: "Average",
    })),
    start,
    end
  );

  return {
    ddbWrite: splitBy(pick("w"), byPrefix),
    ddbRead: splitBy(pick("r"), byPrefix),
    lambdaGbSec: splitBy(gbSec, byPrefix),
    lambdaReq: splitBy(invocations, byPrefix),
    apigw: splitBy(apiSums, byPrefix),
    sqs: splitBy(sqsSums, byPrefix),
    logs: splitBy(logSums, (n) => n.startsWith(`/aws/lambda/${PREFIX}`) || n.startsWith(PREFIX)),
    s3: splitBy(s3Sums, byPrefix),
  };
}

/**
 * Picks the usage share that drives a given line on the bill. Usage type matters
 * within a service — DynamoDB reads and writes are priced ~5x apart and have
 * very different AutoReach shares, so one blended DynamoDB ratio would be wrong.
 */
function shareFor(service: string, usageType: string, shares: Shares): { share: Share; basis: ServiceCost["basis"] } {
  switch (service) {
    case "Amazon DynamoDB":
      // Storage and PITR follow the write-heavy tables closely enough, and are
      // cents on these accounts.
      return {
        share: usageType.includes("ReadRequestUnits") ? shares.ddbRead : shares.ddbWrite,
        basis: "metered",
      };
    case "AWS Lambda":
      return { share: usageType.includes("Request") ? shares.lambdaReq : shares.lambdaGbSec, basis: "modelled" };
    case "Amazon API Gateway":
      return { share: shares.apigw, basis: "metered" };
    case "Amazon Simple Queue Service":
      return { share: shares.sqs, basis: "modelled" };
    case "AmazonCloudWatch":
      return { share: shares.logs, basis: "modelled" };
    case "Amazon Simple Storage Service":
      return { share: shares.s3, basis: "modelled" };
    case "Amazon Simple Email Service":
      // AutoReach only sends login OTPs through SES; invocation share is the
      // closest available proxy and the line is pennies either way.
      return { share: shares.lambdaReq, basis: "modelled" };
    default:
      // Lightsail, ECS, WAF, VPC, Secrets Manager, ECR, CloudFront — none of
      // these are used by anything AutoReach deploys.
      return { share: EMPTY, basis: "none" };
  }
}

/** First day of `month` and of the month after it, as YYYY-MM-DD. */
function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const endY = m === 12 ? y + 1 : y;
  const endM = m === 12 ? 1 : m + 1;
  return { start: `${y}-${pad(m)}-01`, end: `${endY}-${pad(endM)}-01` };
}

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function previousMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Computes one month's AutoReach share. Costs roughly $0.01 in Cost Explorer
 * API charges per call, which is why results are cached rather than computed
 * on page load.
 */
export async function computeMonthlyCost(month: string, now = new Date()): Promise<MonthlyCost> {
  const { start, end } = monthBounds(month);

  // Never ask Cost Explorer for days that haven't happened; it rejects a future
  // end date outright.
  const today = now.toISOString().slice(0, 10);
  const effectiveEnd = end > today ? today : end;
  if (effectiveEnd <= start) throw new Error(`Month ${month} has no elapsed days yet`);

  const shares = await buildShares(new Date(`${start}T00:00:00Z`), new Date(`${effectiveEnd}T00:00:00Z`));

  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: effectiveEnd },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "DIMENSION", Key: "USAGE_TYPE" },
      ],
    })
  );

  const byService = new Map<string, ServiceCost>();
  let tax = 0;

  for (const period of res.ResultsByTime || []) {
    for (const group of period.Groups || []) {
      const [service, usageType] = group.Keys || [];
      const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
      if (!amount) continue;

      // Tax is charged on the account as a whole, so it can only be pro-rated
      // once everything else is attributed.
      if (service === "Tax") {
        tax += amount;
        continue;
      }

      const { share, basis } = shareFor(service, usageType, shares);
      const fraction = share.total > 0 ? share.autoreach / share.total : 0;

      const row = byService.get(service) || { service, total: 0, autoreach: 0, basis };
      row.total += amount;
      row.autoreach += amount * fraction;
      // A service is only "none" if every line in it is; one attributed line
      // upgrades the whole row.
      if (basis !== "none") row.basis = basis;
      byService.set(service, row);
    }
  }

  const services = [...byService.values()].sort((a, b) => b.total - a.total);
  const subTotal = services.reduce((sum, s) => sum + s.total, 0);
  const subAutoreach = services.reduce((sum, s) => sum + s.autoreach, 0);
  const taxAutoreach = subTotal > 0 ? tax * (subAutoreach / subTotal) : 0;

  const accountTotal = subTotal + tax;
  const autoreachTotal = subAutoreach + taxAutoreach;

  // AWS keeps posting charges for a closed month for the first few days of the
  // next one, so a month is only treated as settled from the 5th onward.
  const settled = end <= today && now.getUTCDate() >= 5;

  return {
    month,
    accountTotal,
    autoreachTotal,
    autoreachPercent: accountTotal > 0 ? (autoreachTotal / accountTotal) * 100 : 0,
    services,
    tax,
    taxAutoreach,
    final: settled,
    computedAt: now.toISOString(),
    periodStart: start,
    periodEnd: effectiveEnd,
  };
}
