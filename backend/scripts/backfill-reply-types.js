/**
 * Backfill replyType / replyText on campaign message rows replied to before
 * the webhook started classifying replies (see src/lib/reply-classifier.ts).
 *
 * Reads each replier's inbound messages from the conversations table and runs
 * them through the same classifier the webhook uses. Inbound rows there don't
 * record whether a message was a button tap, so a reply whose text exactly
 * matches one of the campaign template's quick-reply buttons counts as one.
 *
 * Usage (from backend/, after `npx tsc`):
 *   AWS_PROFILE=navin AWS_REGION=ap-south-1 node scripts/backfill-reply-types.js navin <campaignId> [<campaignId> ...] [--force] [--dry-run]
 *
 * --force reclassifies rows that already have a replyType.
 * --dry-run classifies and prints the tally plus sample "other" replies without writing.
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { appendReplyText, classifyReply, mergeReplyType } = require("../dist/lib/reply-classifier");

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const MESSAGES = "autoreach-messages";
const CAMPAIGNS = "autoreach-campaigns";
const TEMPLATES = "autoreach-templates";
// Replies after this long are attributed to whatever was sent next, not this campaign.
const REPLY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** Quick-reply button labels per sending number, lowercased. */
async function buttonTexts(campaign) {
  const out = new Map();
  for (const num of campaign.selectedNumbers || []) {
    const tplName = campaign.templateMappings?.[num.phoneNumberId] || campaign.templateName;
    const r = await doc.send(new GetCommand({
      TableName: TEMPLATES,
      Key: { PK: `BIZ#${campaign.businessId}`, SK: `TPL#${num.phoneNumberId}#${tplName}` },
    }));
    const labels = new Set();
    for (const c of r.Item?.components || []) {
      for (const b of c.buttons || []) if (b.type === "QUICK_REPLY" && b.text) labels.add(b.text.trim().toLowerCase());
    }
    out.set(num.phoneNumberId, labels);
  }
  return out;
}

async function backfill(env, campaignId, { force, dryRun }) {
  const conversations = `autoreach-conversations-${env}`;
  const campaign = (await doc.send(new GetCommand({ TableName: CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } }))).Item;
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
  const buttons = await buttonTexts(campaign);

  const replied = (await queryAll({
    TableName: MESSAGES,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :msg)",
    FilterExpression: "attribute_type(repliedAt, :s)",
    ExpressionAttributeValues: { ":pk": `CAMP#${campaignId}`, ":msg": "MSG#", ":s": "S" },
  })).filter((m) => force || !m.replyType);

  const tally = { button: 0, auto: 0, other: 0, noText: 0 };
  const samples = [];
  const queue = [...replied];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const from = m.sentAt || m.repliedAt;
      const until = new Date(Math.max(Date.parse(m.repliedAt), Date.parse(from)) + REPLY_WINDOW_MS).toISOString();
      const thread = await queryAll({
        TableName: conversations,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :until",
        ExpressionAttributeValues: { ":pk": `PHONE#${m.phoneNumber}#NUM#${m.sendingNumberId}`, ":from": `TS#${from}`, ":until": `TS#${until}` },
      });
      const inbound = thread.filter((c) => c.direction === "inbound" && c.content);

      if (inbound.length === 0) { tally.noText++; continue; }

      const labels = buttons.get(m.sendingNumberId) || new Set();
      let replyType = null;
      let replyText = null;
      // Timing is measured from whatever we last sent, not just the campaign
      // message: a follow-up we sent later (e.g. a manual reply) sets off the
      // recipient's auto-reply all over again, hours after the campaign.
      let lastOutboundAt = m.sentAt;
      const seen = new Set();
      for (const c of thread) {
        if (c.direction === "outbound") { lastOutboundAt = c.timestamp; continue; }
        if (!c.content) continue;
        const text = String(c.content);
        const key = text.trim().toLowerCase();
        // The same text twice is a canned message firing again, not a person.
        const type = seen.has(key)
          ? "auto"
          : classifyReply({ text, isButton: labels.has(key), sentAt: lastOutboundAt, repliedAt: c.timestamp });
        replyType = mergeReplyType(replyType, type);
        if (!seen.has(key)) replyText = appendReplyText(replyText, text);
        seen.add(key);
      }

      tally[replyType]++;
      if (dryRun) {
        if (replyType === "other") samples.push(replyText.slice(0, 80).replace(/\s+/g, " "));
        continue;
      }
      await doc.send(new UpdateCommand({
        TableName: MESSAGES,
        Key: { PK: m.PK, SK: m.SK },
        UpdateExpression: "SET replyType = :t, replyText = :x",
        ExpressionAttributeValues: { ":t": replyType, ":x": replyText },
      }));
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  console.log(`${campaignId}: ${replied.length} replied rows${dryRun ? " (dry run, nothing written)" : ""} →`, tally);
  if (dryRun) for (const t of samples) console.log("  other:", t);
}

async function main() {
  const args = process.argv.slice(2);
  const opts = { force: args.includes("--force"), dryRun: args.includes("--dry-run") };
  const [env, ...ids] = args.filter((a) => !a.startsWith("--"));
  if (!env || ids.length === 0) {
    console.error("Usage: node scripts/backfill-reply-types.js <env> <campaignId> [...] [--force] [--dry-run]");
    process.exit(1);
  }
  for (const id of ids) await backfill(env, id, opts);
}

main().catch((err) => { console.error(err); process.exit(1); });
