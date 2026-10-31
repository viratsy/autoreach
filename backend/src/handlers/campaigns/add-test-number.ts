import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { parseCSVWithHeaders, stringifyCSV } from "../../lib/csv";

const s3 = new S3Client({});
const CSV_BUCKET = process.env.CSV_BUCKET!;

/**
 * Applies a number to one already-created draft's audience immediately.
 * A draft's CSV is never rebuilt after creation (see
 * campaigns/update.ts), so this edits the CSV object already sitting in S3
 * directly, copying every column except identity (phone/name/email) from
 * an existing row so the new contact gets the same workshop_name/date/
 * zoom_link/whatsapp_group the rest of the audience already has.
 * POST /campaigns/{campaignId}/add-test-number
 * Body: { name, phone }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const campaignId = event.pathParameters?.campaignId;
    if (!campaignId) return error(400, "campaignId is required", origin);

    const { name, phone } = JSON.parse(event.body || "{}") as { name?: string; phone?: string };
    if (!name?.trim() || !phone?.trim()) return error(400, "name and phone are required", origin);

    const campaignResult = await docClient.send(
      new GetCommand({ TableName: TABLES.CAMPAIGNS, Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" } })
    );
    const campaign = campaignResult.Item;
    if (!campaign) return error(404, "Campaign not found", origin);
    if (campaign.status !== "draft") return error(400, "Only draft campaigns can be edited", origin);
    if (!campaign.csvS3Key) return error(400, "This campaign has no CSV to add to", origin);

    const csvResult = await s3.send(new GetObjectCommand({ Bucket: CSV_BUCKET, Key: campaign.csvS3Key }));
    const csvText = await csvResult.Body!.transformToString();
    const { headers, records } = parseCSVWithHeaders(csvText);
    if (records.length === 0) {
      return error(400, "This campaign's CSV has no rows to copy workshop details from", origin);
    }

    const templateRow = records[records.length - 1];
    const newRow = { ...templateRow, phone: phone.trim(), name: name.trim(), email: "" };
    records.push(newRow);

    const newCsv = stringifyCSV(headers, records);
    await s3.send(new PutObjectCommand({ Bucket: CSV_BUCKET, Key: campaign.csvS3Key, Body: newCsv, ContentType: "text/csv" }));

    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.CAMPAIGNS,
        Key: { PK: `CAMP#${campaignId}`, SK: "METADATA" },
        UpdateExpression: "SET totalContacts = totalContacts + :one, updatedAt = :now",
        ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
      })
    );

    return success({ totalContacts: (campaign.totalContacts || 0) + 1 }, origin);
  } catch (err) {
    console.error("Add test number error:", err);
    return error(500, "Failed to add test number to campaign", origin);
  }
};
