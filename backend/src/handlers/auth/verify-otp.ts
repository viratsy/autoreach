import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { isEmailAllowed } from "../../lib/auth-config";
import { signJWT } from "../../lib/jwt";
import { success, error } from "../../lib/response";

const OTP_TABLE = process.env.OTP_TABLE!;
const MAX_ATTEMPTS = 3;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { email, otp } = JSON.parse(event.body || "{}");

    if (!email || !otp) return error(400, "Email and OTP are required");
    if (!isEmailAllowed(email)) return error(403, "Unauthorized email");

    const normalizedEmail = email.toLowerCase().trim();

    // Get stored OTP
    const result = await docClient.send(
      new GetCommand({
        TableName: OTP_TABLE,
        Key: { PK: `OTP#${normalizedEmail}`, SK: "LATEST" },
      })
    );

    const record = result.Item;
    if (!record) return error(400, "No OTP found. Please request a new one.");

    // Check expiry
    if (record.expiresAt < Math.floor(Date.now() / 1000)) {
      return error(400, "OTP expired. Please request a new one.");
    }

    // Check attempts
    if (record.attempts >= MAX_ATTEMPTS) {
      return error(429, "Too many attempts. Please request a new OTP.");
    }

    // Increment attempts
    await docClient.send(
      new UpdateCommand({
        TableName: OTP_TABLE,
        Key: { PK: `OTP#${normalizedEmail}`, SK: "LATEST" },
        UpdateExpression: "SET attempts = attempts + :one",
        ExpressionAttributeValues: { ":one": 1 },
      })
    );

    // Verify OTP
    if (record.otp !== otp) {
      return error(400, "Invalid OTP");
    }

    // Generate JWT
    const token = signJWT(normalizedEmail);

    return success({
      token,
      email: normalizedEmail,
      expiresIn: "7d",
    });
  } catch (err) {
    console.error("Verify OTP error:", err);
    return error(500, "Verification failed");
  }
};
