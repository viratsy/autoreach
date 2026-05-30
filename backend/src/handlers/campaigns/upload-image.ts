import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { success, error, options } from "../../lib/response";

const s3 = new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });
const BUCKET = process.env.CSV_BUCKET!;
const CDN_URL = process.env.CDN_URL || "";

/**
 * Generate a presigned URL for image upload.
 * POST /campaigns/upload-image { fileName, contentType }
 * Returns: uploadUrl (for PUT), cdnUrl (for use in templates)
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { fileName, contentType } = JSON.parse(event.body || "{}");
    if (!fileName) return error(400, "fileName is required", origin);

    const key = `images/${Date.now()}_${fileName}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType || "image/jpeg",
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    // CDN URL for serving the image
    const cdnUrl = CDN_URL ? `${CDN_URL}/${key}` : `https://${BUCKET}.s3.ap-south-1.amazonaws.com/${key}`;

    return success({ uploadUrl, s3Key: key, cdnUrl }, origin);
  } catch (err) {
    console.error("Upload image URL error:", err);
    return error(500, "Failed to generate upload URL", origin);
  }
};
