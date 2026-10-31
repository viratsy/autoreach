import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";

const s3 = new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });
const BUCKET = process.env.CSV_BUCKET!;
const CDN_URL = process.env.CDN_URL || "";
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Generate a presigned URL for image upload.
 * POST /campaigns/upload-image { fileName, contentType }
 * Returns: uploadUrl (for PUT), cdnUrl (for use in templates)
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const { fileName, contentType } = JSON.parse(event.body || "{}");
    if (!fileName) return error(400, "fileName is required", origin);
    if (contentType && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return error(400, `contentType must be one of ${ALLOWED_CONTENT_TYPES.join(", ")}`, origin);
    }

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
