import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { success, error, options } from "../../lib/response";

const s3 = new S3Client({});
const BUCKET = process.env.CSV_BUCKET!;
const CDN_URL = process.env.CDN_URL || "";

/**
 * List uploaded images from S3.
 * GET /campaigns/images?limit=10&startAfter=key
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const limit = parseInt(event.queryStringParameters?.limit || "10");
    const startAfter = event.queryStringParameters?.startAfter || undefined;

    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "images/",
        MaxKeys: limit + 1, // +1 to check if there are more
        StartAfter: startAfter,
      })
    );

    const allItems = (result.Contents || []).filter(
      (obj) => obj.Key && /\.(jpg|jpeg|png|webp|gif)$/i.test(obj.Key)
    );

    const hasMore = allItems.length > limit;
    const items = allItems.slice(0, limit);

    const images = items
      .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0))
      .map((obj) => ({
        s3Key: obj.Key,
        fileName: obj.Key!.split("/").pop() || obj.Key,
        cdnUrl: CDN_URL ? `${CDN_URL}/${obj.Key}` : `https://${BUCKET}.s3.ap-south-1.amazonaws.com/${obj.Key}`,
        size: obj.Size,
        uploadedAt: obj.LastModified?.toISOString(),
      }));

    return success({ images, hasMore, lastKey: hasMore ? items[items.length - 1]?.Key : null }, origin);
  } catch (err) {
    console.error("List images error:", err);
    return error(500, "Failed to list images", origin);
  }
};
