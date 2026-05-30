import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { success, error, options } from "../../lib/response";

const s3 = new S3Client({});
const BUCKET = process.env.CSV_BUCKET!;

/**
 * Get headers, row count, and preview of an S3 CSV file.
 * Only reads enough data for preview (first ~50KB) to handle large files.
 * GET /campaigns/file-preview?s3Key=uploads/xxx.csv
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const s3Key = event.queryStringParameters?.s3Key;
    if (!s3Key) return error(400, "s3Key is required", origin);

    // Get file size first
    const headResult = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key })
    );
    const fileSize = headResult.ContentLength || 0;

    // For preview, only read first 50KB (enough for headers + 10 rows)
    const range = fileSize > 50000 ? "bytes=0-50000" : undefined;

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Range: range,
      })
    );

    const csvText = await result.Body!.transformToString();
    const lines = csvText.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());

    // For total row count on large files, estimate from file size
    let totalRows: number;
    if (range && lines.length > 1) {
      // Estimate: average row size * total file size
      const avgRowSize = csvText.length / lines.length;
      totalRows = Math.floor(fileSize / avgRowSize) - 1;
    } else {
      totalRows = lines.length - 1;
    }

    // Only first 10 rows for preview
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
