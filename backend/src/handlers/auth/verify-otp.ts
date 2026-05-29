import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { isEmailAllowed } from "../../lib/auth-config";
import { signJWT } from "../../lib/jwt";
import { success, error, options } from "../../lib/response";

const OTP_TABLE = process.env.OTP_TABLE!;
const MAX_ATTEMPTS = 3;

export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { email, otp } = JSON.parse(event.body || "{}");

    if (!email || !otp) return error(400, "Email and OTP are required", origin);
    if (!isEmailAllowed(email)) return error(403, "Unauthorized email", origin);

    const normalizedEmail = email.toLowerCase().trim();

    const result = await docClient.send(
      new GetCommand({
        TableName: OTP_TABLE,
        Key: { PK: `OTP#${normalizedEmail}`, SK: "LATEST" },
      })
    );

    const record = result.Item;
    if (!record) return error(400, "No OTP found. Please request a new one.", origin);

    if (record.expiresAt < Math.floor(Date.now() / 1000)) {
      return error(400, "OTP expired. Please request a new one.", origin);
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      return error(429, "Too many attempts. Please request a new OTP.", origin);
    }

    await docClient.send(
      new UpdateCommand({
        TableName: OTP_TABLE,
        Key: { PK: `OTP#${normalizedEmail}`, SK: "LATEST" },
        UpdateExpression: "SET attempts = attempts + :one",
        ExpressionAttributeValues: { ":one": 1 },
      })
    );

    if (record.otp !== otp) {
      return error(400, "Invalid OTP", origin);
    }

    const token = signJWT(normalizedEmail);

    return success({ token, email: normalizedEmail, expiresIn: "7d" }, origin);
  } catch (err) {
    console.error("Verify OTP error:", err);
    return error(500, "Verification failed", origin);
  }
};
