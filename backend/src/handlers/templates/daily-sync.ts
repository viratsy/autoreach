import { Handler } from "aws-lambda";
import { ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";

/**
 * Daily template sync - runs via EventBridge scheduled rule.
 * Fetches latest templates from Meta for all businesses.
 */
export const handler: Handler = async () => {
  console.log("Daily template sync started");

  try {
    // Get all businesses
    const bizResult = await docClient.send(
      new ScanCommand({ TableName: TABLES.BUSINESSES })
    );

    const businesses = bizResult.Items || [];
    console.log(`Found ${businesses.length} businesses`);

    for (const business of businesses) {
      const accessToken = business.accessToken;
      const phoneNumbers = business.phoneNumbers || [];

      if (!accessToken) continue;

      for (const pn of phoneNumbers) {
        const wabaid = pn.wabaid;
        if (!wabaid) continue;

        try {
          const response = await fetch(
            `https://graph.facebook.com/v18.0/${wabaid}/message_templates?limit=100`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          const data = (await response.json()) as {
            data?: { name: string; language: string; category: string; status: string; components: unknown[] }[];
          };

          if (!response.ok || !data.data) continue;

          const templates = data.data.filter((t) => t.status === "APPROVED");

          for (const tpl of templates) {
            await docClient.send(
              new PutCommand({
                TableName: TABLES.TEMPLATES,
                Item: {
                  PK: `BIZ#${business.businessId}`,
                  SK: `TPL#${pn.phoneNumberId}#${tpl.name}`,
                  templateName: tpl.name,
                  language: tpl.language,
                  category: tpl.category,
                  components: tpl.components,
                  parameterCount: countParameters(tpl.components),
                  status: tpl.status.toLowerCase(),
                  lastSyncedAt: new Date().toISOString(),
                },
              })
            );
          }

          console.log(`Synced ${templates.length} templates for ${pn.displayName} (${pn.phoneNumberId})`);
        } catch (err) {
          console.error(`Failed to sync templates for ${pn.phoneNumberId}:`, err);
        }
      }
    }

    console.log("Daily template sync completed");
  } catch (err) {
    console.error("Daily sync error:", err);
  }
};

function countParameters(components: unknown[]): number {
  let count = 0;
  for (const comp of components as { type: string; text?: string }[]) {
    if (comp.type === "BODY" && comp.text) {
      const matches = comp.text.match(/\{\{\d+\}\}/g);
      count += matches ? matches.length : 0;
    }
  }
  return count;
}
