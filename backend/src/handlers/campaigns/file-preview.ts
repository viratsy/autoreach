import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { success, error, options } from "../../lib/response";

const s3 = new S3Client({});
const BUCKET = process.env.CSV_BUCKET!;

/**
 * Get headers and preview of an S3 CSV file.
 * GET /campaigns/file-preview?s3Key=uploads/xxx.csv
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const s3Key = event.queryStringParameters?.s3Key;
    if (!s3Key) return error(400, "s3Key is required", origin);

    const result = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: s3Key })
    );

    const csvText = await result.Body!.transformToString();
    const lines = csvText.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());

    // Count rows and get preview
    const totalRows = lines.length - 1;
    const preview = lines.slice(1, 11).map((line) => {
      const values = line.split(",").map((v) => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => (row[h] = values[i] || ""));
      return row;
    });

    return success({ headers, totalRows, preview }, origin);
  } catch (err) {
    console.error("File preview error:", err);
    return error(500, "Failed to read file", origin);
  }
};
