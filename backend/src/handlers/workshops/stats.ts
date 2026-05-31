import { APIGatewayProxyHandler } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";

const REENGAGEMENT_TABLE = process.env.REENGAGEMENT_TABLE!;

/**
 * Get stats summary per workshop.
 * GET /workshops/stats
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const result = await docClient.send(
      new ScanCommand({ TableName: REENGAGEMENT_TABLE })
    );

    const items = result.Items || [];

    // Group by wsCode
    const byWorkshop: Record<string, {
      workshopName: string;
      wsCode: string;
      total: number;
      active: number;
      converted: number;
      completed: number;
      avgCounter: number;
    }> = {};

    for (const item of items) {
      const code = item.wsCode;
      if (!byWorkshop[code]) {
        byWorkshop[code] = {
          workshopName: item.workshopName,
          wsCode: code,
          total: 0,
          active: 0,
          converted: 0,
          completed: 0,
          avgCounter: 0,
        };
      }
      byWorkshop[code].total++;
      if (item.status === "active") byWorkshop[code].active++;
      else if (item.status === "converted") byWorkshop[code].converted++;
      else if (item.status === "completed") byWorkshop[code].completed++;
      byWorkshop[code].avgCounter += item.counter || 0;
    }

    // Calculate averages
    const stats = Object.values(byWorkshop).map((ws) => ({
      ...ws,
      avgCounter: ws.total > 0 ? Math.round((ws.avgCounter / ws.total) * 10) / 10 : 0,
    }));

    return success({ stats, totalContacts: items.length }, origin);
  } catch (err) {
    console.error("Stats error:", err);
    return error(500, "Failed to get stats", origin);
  }
};
