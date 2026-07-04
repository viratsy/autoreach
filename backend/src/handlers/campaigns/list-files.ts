import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { success, error, options } from "../../lib/response";

const s3 = new S3Client({});
const BUCKET = process.env.CSV_BUCKET!;

/**
 * List uploaded CSV files from S3 with pagination.
 * GET /campaigns/files?limit=10&startAfter=key
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const limit = parseInt(event.queryStringParameters?.limit || "10");

    // Fetch all CSV files (S3 lists alphabetically, we need latest by date)
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "uploads/",
        MaxKeys: 200, // Fetch more to sort by date
      })
    );

    const allItems = (result.Contents || []).filter(
      (obj) => obj.Key && obj.Key.endsWith(".csv")
    );

    // Sort by LastModified descending (latest first)
    allItems.sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

    const items = allItems.slice(0, limit);

    const files = items.map((obj) => ({
      s3Key: obj.Key,
      fileName: obj.Key!.split("/").pop() || obj.Key,
      size: obj.Size,
      uploadedAt: obj.LastModified?.toISOString(),
    }));

    return success({ files, hasMore: allItems.length > limit, lastKey: null }, origin);
  } catch (err) {
    console.error("List files error:", err);
    return error(500, "Failed to list files", origin);
  }
};
