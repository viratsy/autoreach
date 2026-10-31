import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

/**
 * Delivery tracking for messages sent OUTSIDE AutoReach — chiefly the signup
 * confirmations free_workshop_meta sends, which it logs to comm_messages with
 * their wamid. Meta delivers the status webhooks for any number AutoReach
 * manages to AutoReach (not to the legacy whatsapp_response Lambda that used
 * to update those rows), so without this those rows sat at "sent" forever.
 *
 * Writes the same shape whatsapp_response does — upper-case status,
 * status_rank, last_event_ts, never downgrading — because msgs_status reads
 * these rows for the signup delivery stats.
 */
const COMM_TABLE = process.env.COMM_TABLE || "comm_messages";
const WA_ID_INDEX = "wa_message_id-index";
const STATUS_RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3, REPLIED: 4, FAILED: 90 };

async function findKeyByWamid(wamid: string): Promise<Record<string, unknown> | null> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: COMM_TABLE,
      IndexName: WA_ID_INDEX,
      KeyConditionExpression: "wa_message_id = :w",
      ExpressionAttributeValues: { ":w": wamid },
      Limit: 1,
    })
  );
  const item = res.Items?.[0];
  return item ? { message_key: item.message_key } : null;
}

async function updateIfNotDowngrade(
  key: Record<string, unknown>,
  set: string,
  names: Record<string, string>,
  values: Record<string, unknown>
) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: COMM_TABLE,
        Key: key,
        UpdateExpression: set,
        ConditionExpression: "attribute_not_exists(status_rank) OR :r >= status_rank",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (err) {
    // An older event arriving after a newer one — ignore, same as whatsapp_response.
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
  }
}

export async function trackCommStatus(status: {
  id: string;
  status: string;
  timestamp?: string;
  errors?: unknown[];
}): Promise<void> {
  const st = (status.status || "").toUpperCase();
  const rank = STATUS_RANK[st];
  if (!rank) return;
  const key = await findKeyByWamid(status.id);
  if (!key) return;

  const names: Record<string, string> = { "#st": "status" };
  const values: Record<string, unknown> = {
    ":s": st,
    ":r": rank,
    ":t": Number(status.timestamp || 0) * 1000 || Date.now(),
  };
  let set = "SET #st = :s, status_rank = :r, last_event_ts = :t";
  if (status.errors?.length) {
    names["#er"] = "error";
    values[":e"] = status.errors;
    set += ", #er = :e";
  }
  await updateIfNotDowngrade(key, set, names, values);
}

export async function trackCommReply(parentWamid: string, text: string): Promise<void> {
  const key = await findKeyByWamid(parentWamid);
  if (!key) return;
  const now = Date.now();
  await updateIfNotDowngrade(
    key,
    "SET #st = :s, status_rank = :r, last_event_ts = :t, last_reply_text = :rt, last_reply_ts = :t",
    { "#st": "status" },
    { ":s": "REPLIED", ":r": STATUS_RANK.REPLIED, ":t": now, ":rt": text }
  );
}
