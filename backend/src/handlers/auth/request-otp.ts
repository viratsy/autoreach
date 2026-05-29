import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { docClient } from "../../lib/dynamo";
import { isEmailAllowed } from "../../lib/auth-config";
import { success, error, options } from "../../lib/response";

const ses = new SESClient({});
const OTP_TABLE = process.env.OTP_TABLE!;
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL!;

function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { email } = JSON.parse(event.body || "{}");

    if (!email) return error(400, "Email is required", origin);

    if (!isEmailAllowed(email)) {
      return error(403, "This email is not authorized to access the platform", origin);
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000;

    await docClient.send(
      new PutCommand({
        TableName: OTP_TABLE,
        Item: {
          PK: `OTP#${email.toLowerCase().trim()}`,
          SK: "LATEST",
          otp,
          expiresAt: Math.floor(expiresAt / 1000),
          attempts: 0,
          createdAt: new Date().toISOString(),
        },
      })
    );

    await ses.send(
      new SendEmailCommand({
        Source: SES_FROM_EMAIL,
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: "AutoReach - Your Login OTP" },
          Body: {
            Html: {
              Data: `
                <div style="font-family: sans-serif; padding: 20px;">
                  <h2 style="color: #16a34a;">AutoReach</h2>
                  <p>Your one-time login code is:</p>
                  <h1 style="letter-spacing: 8px; font-size: 36px; color: #111;">${otp}</h1>
                  <p style="color: #666;">This code expires in 5 minutes.</p>
                  <p style="color: #999; font-size: 12px;">If you didn't request this, ignore this email.</p>
                </div>
              `,
            },
            Text: { Data: `Your AutoReach login OTP is: ${otp}. Expires in 5 minutes.` },
          },
        },
      })
    );

    return success({ message: "OTP sent to your email" }, origin);
  } catch (err) {
    console.error("Request OTP error:", err);
    return error(500, "Failed to send OTP", origin);
  }
};
