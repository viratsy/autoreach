import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomBytes } from "crypto";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { PhoneNumber, Provider } from "../../lib/types";
import { getAuthEmail } from "../../lib/auth";
import { upsertPhoneNumberLookups } from "../../lib/phone-lookup";

/**
 * Create a new business. Supports meta, aisensy, and wati providers.
 * POST /businesses { businessName, provider, accessToken?, metaBusinessId?, phoneNumbers }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const body = JSON.parse(event.body || "{}") as {
      businessName?: string;
      provider?: Provider;
      accessToken?: string;
      metaBusinessId?: string;
      phoneNumbers?: PhoneNumber[];
    };

    const { businessName, phoneNumbers } = body;
    const provider: Provider = body.provider || "meta";

    if (!businessName) return error(400, "businessName is required", origin);
    if (!phoneNumbers || phoneNumbers.length === 0) {
      return error(400, "At least one phone number is required", origin);
    }

    for (const pn of phoneNumbers) {
      if (!pn.phoneNumberId || !pn.displayName) {
        return error(400, "Each phone number needs phoneNumberId and displayName", origin);
      }
      if (provider === "meta" && !pn.wabaid) {
        return error(400, `Number "${pn.displayName}" is missing a wabaid`, origin);
      }
      if ((provider === "aisensy" || provider === "wati") && !pn.apiKey) {
        return error(400, `Number "${pn.displayName}" is missing an apiKey`, origin);
      }
      if (provider === "wati" && !pn.endpoint) {
        return error(400, `Number "${pn.displayName}" is missing a WATI endpoint`, origin);
      }
    }
    if (provider === "meta" && !body.accessToken) {
      return error(400, "accessToken is required for meta businesses", origin);
    }

    const businessId = `biz_${randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();

    // Meta's API doesn't reliably return the real 24h messaging tier via the
    // phone-number endpoint (confirmed — quality-check.ts's fetch comes back
    // empty), so new numbers default to TIER_100K here rather than showing an
    // overly-conservative capacity warning for numbers nobody's had a chance to
    // check yet. This is a placeholder assumption, not a verified value — update
    // it manually if a number's real tier is ever known to be lower.
    const numbersWithDefaultTier = phoneNumbers.map((pn) => ({
      ...pn,
      messagingLimit: pn.messagingLimit || "TIER_100K",
    }));

    await docClient.send(
      new PutCommand({
        TableName: TABLES.BUSINESSES,
        Item: {
          PK: `BIZ#${businessId}`,
          SK: "METADATA",
          businessId,
          businessName,
          provider,
          accessToken: body.accessToken || "",
          metaBusinessId: body.metaBusinessId || "",
          phoneNumbers: numbersWithDefaultTier,
          createdAt: now,
          updatedAt: now,
        },
      })
    );

    await upsertPhoneNumberLookups(businessId, phoneNumbers.map((pn) => pn.phoneNumberId));

    return success({ businessId }, origin);
  } catch (err) {
    console.error("Error creating business:", err);
    return error(500, "Failed to create business", origin);
  }
};
