import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { success, error, options } from "../../lib/response";

const s3 = new S3Client({});
const BUCKET = process.env.CSV_BUCKET!;

/**
 * List uploaded CSV files from S3.
 * GET /campaigns/files
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "uploads/",
        MaxKeys: 50,
      })
    );

    const files = (result.Contents || [])
      .filter((obj) => obj.Key && obj.Key.endsWith(".csv"))
      .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0))
      .map((obj) => ({
        s3Key: obj.Key,
        fileName: obj.Key!.split("/").pop() || obj.Key,
        size: obj.Size,
        uploadedAt: obj.LastModified?.toISOString(),
      }));

    return success({ files }, origin);
  } catch (err) {
    console.error("List files error:", err);
    return error(500, "Failed to list files", origin);
  }
};
