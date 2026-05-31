import { APIGatewayProxyEvent } from "aws-lambda";
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";

const REENGAGEMENT_TABLE = process.env.REENGAGEMENT_TABLE!;

/**
 * Download contacts as CSV.
 * GET /workshops/download?wsCode=aitools&status=active
 */
export const handler = async (event: APIGatewayProxyEvent) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
      },
      body: "",
    };
  }

  try {
    const wsCode = event.queryStringParameters?.wsCode;
    const status = event.queryStringParameters?.status;

    let items;

    if (status) {
      const result = await docClient.send(
        new QueryCommand({
          TableName: REENGAGEMENT_TABLE,
          IndexName: "GSI1",
          KeyConditionExpression: wsCode
            ? "GSI1PK = :pk AND begins_with(GSI1SK, :sk)"
            : "GSI1PK = :pk",
          ExpressionAttributeValues: {
            ":pk": `STATUS#${status}`,
            ...(wsCode ? { ":sk": `WS#${wsCode}` } : {}),
          },
        })
      );
      items = result.Items || [];
    } else {
      const result = await docClient.send(
        new ScanCommand({ TableName: REENGAGEMENT_TABLE })
      );
      items = result.Items || [];
    }

    // Build CSV
    const headers = "name,phone,email,workshop,wsCode,counter,status,lastBatchDate,registeredAt";
    const rows = items.map((item) =>
      [
        item.name,
        item.phone,
        item.email,
        item.workshopName,
        item.wsCode,
        item.counter,
        item.status,
        item.lastBatchDate,
        item.registeredAt,
      ].join(",")
    );

    const csv = [headers, ...rows].join("\n");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="workshop-contacts-${wsCode || "all"}.csv"`,
        "Access-Control-Allow-Origin": origin || "*",
      },
      body: csv,
    };
  } catch (err) {
    console.error("Download error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin || "*" },
      body: JSON.stringify({ error: "Failed to download" }),
    };
  }
};
