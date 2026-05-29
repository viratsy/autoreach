import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { success, error, options } from "../../lib/response";

const s3 = new S3Client({});
const BUCKET = process.env.CSV_BUCKET!;

/**
 * Generate a presigned URL for CSV upload.
 * POST /campaigns/upload-url { fileName }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { fileName } = JSON.parse(event.body || "{}");
    if (!fileName) return error(400, "fileName is required", origin);

    const key = `uploads/${Date.now()}_${fileName}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: "text/csv",
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    return success({ uploadUrl, s3Key: key }, origin);
  } catch (err) {
    console.error("Upload URL error:", err);
    return error(500, "Failed to generate upload URL", origin);
  }
};
