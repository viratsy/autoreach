import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

// The real, shared lead-capture table (not one of our own SAM-managed
// tables) — literally named "database" in both AWS accounts, 200K+ rows
// across every workshop ever run. Never Scan this — always Query via
// workshop_date_ymd_lean-index, scoped to one workshop_name at a time (its
// partition key).
//
// Deliberately a lean INCLUDE-projection index (phone/name/email only), not
// the full ALL-projection "workshop_name-workshop_date_ymd-index" — that one
// carries every raw lead field (page_url, user_agent, utm_* — some items
// approach 1-2KB), which caps each Query page at ~850 items. A busy
// workshop's month can be 40K+ rows, meaning 50+ sequential page round-trips
// (Query pagination can't be parallelized — each page needs the previous
// page's LastEvaluatedKey), which blew straight through API Gateway's 29s
// limit on a real request. The lean projection lets far more items fit per
// 1MB page, cutting that page count proportionally.
const DATABASE_TABLE = process.env.DATABASE_TABLE || "database";
const GSI_NAME = "workshop_date_ymd_lean-index";

export interface DatabaseLead {
  id: string;
  phone: string;
  name: string;
  email?: string;
  workshop_name: string;
  workshop_date_ymd: string;
}

async function queryAllPages(keyConditionExpression: string, values: Record<string, string>): Promise<DatabaseLead[]> {
  const items: DatabaseLead[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: DATABASE_TABLE,
        IndexName: GSI_NAME,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...((result.Items || []) as DatabaseLead[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** All leads for one exact workshop_name string within a workshop_date_ymd range. */
export function queryLeadsByDateRange(workshopName: string, startDate: string, endDate: string): Promise<DatabaseLead[]> {
  return queryAllPages("workshop_name = :wn AND workshop_date_ymd BETWEEN :start AND :end", {
    ":wn": workshopName,
    ":start": startDate,
    ":end": endDate,
  });
}

/** All leads for one exact workshop_name string on one exact workshop_date_ymd. */
export function queryLeadsByExactDate(workshopName: string, batchDate: string): Promise<DatabaseLead[]> {
  return queryAllPages("workshop_name = :wn AND workshop_date_ymd = :bd", {
    ":wn": workshopName,
    ":bd": batchDate,
  });
}
