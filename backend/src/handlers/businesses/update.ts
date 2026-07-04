import { APIGatewayProxyHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { PhoneNumber, Provider } from "../../lib/types";
import { getAuthEmail } from "../../lib/auth";

/**
 * Update an existing business (rename, change provider config, edit numbers).
 * PUT /businesses/{businessId} { businessName, provider, accessToken?, metaBusinessId?, phoneNumbers }
 *
 * Secrets (apiKey/accessToken) are never sent back to the browser (see businesses/list.ts),
 * so an edit submission may omit them for existing numbers — in that case the previously
 * stored value is preserved. Only genuinely new numbers must supply a fresh secret.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const businessId = event.pathParameters?.businessId;
    if (!businessId) return error(400, "businessId is required", origin);

    const existing = await docClient.send(
      new GetCommand({ TableName: TABLES.BUSINESSES, Key: { PK: `BIZ#${businessId}`, SK: "METADATA" } })
    );
    if (!existing.Item) return error(404, "Business not found", origin);

    const body = JSON.parse(event.body || "{}") as {
      businessName?: string;
      provider?: Provider;
      accessToken?: string;
      metaBusinessId?: string;
      phoneNumbers?: PhoneNumber[];
    };

    const provider: Provider = body.provider || existing.Item.provider || "meta";

    const existingNumbers = new Map(
      ((existing.Item.phoneNumbers || []) as PhoneNumber[]).map((pn) => [pn.phoneNumberId, pn])
    );
    const incomingNumbers = (body.phoneNumbers ?? existing.Item.phoneNumbers ?? []) as PhoneNumber[];
    const phoneNumbers: PhoneNumber[] = incomingNumbers.map((pn) => {
      const prev = existingNumbers.get(pn.phoneNumberId);
      return {
        ...pn,
        wabaid: pn.wabaid || prev?.wabaid,
        apiKey: pn.apiKey || prev?.apiKey,
        endpoint: pn.endpoint || prev?.endpoint,
      };
    });

    if (!body.businessName) return error(400, "businessName is required", origin);
    if (phoneNumbers.length === 0) {
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

    const accessToken = body.accessToken || existing.Item.accessToken || "";
    if (provider === "meta" && !accessToken) {
      return error(400, "accessToken is required for meta businesses", origin);
    }

    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.BUSINESSES,
        Key: { PK: `BIZ#${businessId}`, SK: "METADATA" },
        UpdateExpression:
          "SET businessName = :name, provider = :provider, accessToken = :token, metaBusinessId = :mbid, phoneNumbers = :numbers, updatedAt = :now",
        ExpressionAttributeValues: {
          ":name": body.businessName,
          ":provider": provider,
          ":token": accessToken,
          ":mbid": body.metaBusinessId ?? existing.Item.metaBusinessId ?? "",
          ":numbers": phoneNumbers,
          ":now": new Date().toISOString(),
        },
      })
    );

    return success({ businessId }, origin);
  } catch (err) {
    console.error("Error updating business:", err);
    return error(500, "Failed to update business", origin);
  }
};
