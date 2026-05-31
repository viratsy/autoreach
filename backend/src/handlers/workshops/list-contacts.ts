import { APIGatewayProxyHandler } from "aws-lambda";
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const REENGAGEMENT_TABLE = process.env.REENGAGEMENT_TABLE!;

/**
 * List contacts in re-engagement table.
 * GET /workshops/contacts?wsCode=aitools&status=active
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const wsCode = event.queryStringParameters?.wsCode;
    const status = event.queryStringParameters?.status || "active";

    let items;

    if (status) {
      // Use GSI to query by status
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
      // Scan all (fallback)
      const result = await docClient.send(
        new ScanCommand({ TableName: REENGAGEMENT_TABLE })
      );
      items = result.Items || [];
    }

    const contacts = items.map((item) => ({
      name: item.name,
      phone: item.phone,
      email: item.email,
      workshopName: item.workshopName,
      wsCode: item.wsCode,
      counter: item.counter,
      status: item.status,
      lastBatchDate: item.lastBatchDate,
      registeredAt: item.registeredAt,
    }));

    return success({ contacts, total: contacts.length }, origin);
  } catch (err) {
    console.error("List contacts error:", err);
    return error(500, "Failed to list contacts", origin);
  }
};
