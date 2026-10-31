import { Handler } from "aws-lambda";
import { ScanCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "../../lib/dynamo";
import { BusinessRecord } from "../../lib/types";
import { getAvailableNumbers } from "../../lib/reengagement-contacts";
import { createNotification } from "../notifications/index";

const CONFIG_TABLE = process.env.WORKSHOP_CONFIG_TABLE || "autoreach-workshop-config-hardik";

/**
 * Nightly sweep for two related problems: a number removed from Meta
 * Business Manager directly (there's no webhook for that — it just silently
 * keeps failing every send forever), and a number whose approval for a
 * specific template gets revoked after a campaign already locked it in as a
 * sender. Both leave a draft/scheduled campaign carrying a sending number
 * that will fail at send time; this keeps selectedNumbers continuously
 * accurate instead of only discovering the problem when messages bounce.
 * Never touches running/completed campaigns — those are historical record.
 */
export const handler: Handler = async () => {
  console.log("Number health sweep started");
  try {
    const bizResult = await docClient.send(new ScanCommand({ TableName: TABLES.BUSINESSES }));
    const businesses = (bizResult.Items || []) as BusinessRecord[];

    for (const business of businesses) {
      if ((business.provider || "meta") !== "meta") continue;
      const numbers = business.phoneNumbers || [];
      if (numbers.length === 0) continue;

      // 1. Numbers that no longer exist on Meta at all.
      const deadIds = new Set<string>();
      await Promise.all(
        numbers.map(async (pn) => {
          if (await checkNumberRemoved(pn.phoneNumberId, business.accessToken)) deadIds.add(pn.phoneNumberId);
        })
      );

      if (deadIds.size > 0) {
        const deadLabels = numbers
          .filter((n) => deadIds.has(n.phoneNumberId))
          .map((n) => `${n.displayName} (${n.displayNumber})`);
        console.log(`Business ${business.businessId}: ${deadIds.size} number(s) removed from Business Manager: ${deadLabels.join(", ")}`);

        const remainingNumbers = numbers.filter((n) => !deadIds.has(n.phoneNumberId));
        await docClient.send(
          new UpdateCommand({
            TableName: TABLES.BUSINESSES,
            Key: { PK: business.PK, SK: business.SK },
            UpdateExpression: "SET phoneNumbers = :n, updatedAt = :now",
            ExpressionAttributeValues: { ":n": remainingNumbers, ":now": new Date().toISOString() },
          })
        );

        await pruneFromWorkshopConfigs(deadIds);

        try {
          await createNotification({
            type: "number_removed",
            businessId: business.businessId,
            businessName: business.businessName,
            phoneNumberId: Array.from(deadIds)[0],
            phoneDisplayName: deadLabels.join(", "),
            errorMessage: `${deadIds.size} number${deadIds.size !== 1 ? "s" : ""} no longer exist on Meta (removed from Business Manager) — auto-removed from Workshop Config: ${deadLabels.join(", ")}`,
          });
        } catch (err) {
          // Removal itself already succeeded above — don't let a notification
          // hiccup abort the rest of the sweep for other businesses.
          console.error(`Failed to notify about removed numbers for ${business.businessId}:`, err);
        }
      }

      // 2. Always re-validate draft/scheduled campaigns — existence
      // (deadIds, possibly empty) plus a fresh per-template approval check,
      // independent of whether any number was found fully gone above.
      const { cleaned, flagged } = await pruneFromCampaigns(business.businessId, business.businessName, deadIds);
      if (cleaned > 0 || flagged > 0) {
        console.log(`Business ${business.businessId}: cleaned ${cleaned} campaign(s), flagged ${flagged} with zero valid senders left`);
      }
    }

    console.log("Number health sweep completed");
  } catch (err) {
    console.error("Number health sweep error:", err);
  }
};

// Deliberately narrow — only Meta's specific "this object is gone" phrasing
// counts as removed, so a transient auth/rate-limit error never gets
// misread as "the number was deleted" and wrongly pruned.
async function checkNumberRemoved(phoneNumberId: string, accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}?fields=id`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) return false;
    const data = (await res.json()) as { error?: { message?: string } };
    return (data.error?.message || "").toLowerCase().includes("does not exist");
  } catch {
    return false; // inconclusive network hiccup — never prune on uncertainty
  }
}

async function pruneFromWorkshopConfigs(deadIds: Set<string>): Promise<void> {
  const result = await docClient.send(new ScanCommand({ TableName: CONFIG_TABLE }));
  for (const item of result.Items || []) {
    const nums = (item.numbers || {}) as Record<string, unknown>;
    const toRemove = Object.keys(nums).filter((id) => deadIds.has(id));
    if (toRemove.length === 0) continue;

    const names: Record<string, string> = {};
    const removeExpr = toRemove
      .map((id, i) => {
        names[`#k${i}`] = id;
        return `numbers.#k${i}`;
      })
      .join(", ");

    await docClient.send(
      new UpdateCommand({
        TableName: CONFIG_TABLE,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: `REMOVE ${removeExpr} SET updatedAt = :now`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
    );
    console.log(`Workshop Config ${item.PK}: removed ${toRemove.join(", ")}`);
  }
}

async function pruneFromCampaigns(
  businessId: string,
  businessName: string,
  deadIds: Set<string>
): Promise<{ cleaned: number; flagged: number }> {
  let cleaned = 0;
  let flagged = 0;

  for (const status of ["draft", "scheduled"]) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLES.CAMPAIGNS,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :s",
        FilterExpression: "businessId = :b",
        ExpressionAttributeValues: { ":s": `STATUS#${status}`, ":b": businessId },
      })
    );

    for (const camp of result.Items || []) {
      const selected = (camp.selectedNumbers || []) as { phoneNumberId: string }[];
      if (selected.length === 0 || !camp.templateName) continue;

      const stillExists = selected.filter((n) => !deadIds.has(n.phoneNumberId));
      const approvedIds = new Set(
        await getAvailableNumbers(businessId, stillExists.map((n) => n.phoneNumberId), camp.templateName as string)
      );
      const kept = stillExists.filter((n) => approvedIds.has(n.phoneNumberId));

      if (kept.length === selected.length) continue; // nothing changed for this campaign

      if (kept.length === 0) {
        // Nothing left to send from — leave selectedNumbers as-is (a human
        // needs to pick a replacement) rather than silently emptying the
        // sender list on an otherwise-ready campaign.
        try {
          await createNotification({
            type: "campaign_stuck",
            businessId,
            businessName,
            phoneNumberId: "",
            phoneDisplayName: "",
            campaignId: camp.campaignId as string,
            errorMessage: `All of this campaign's sending numbers were removed from Business Manager or lost template approval — needs a new number picked manually before it can send.`,
          });
        } catch (err) {
          console.error(`Failed to notify about zero-sender campaign ${camp.campaignId}:`, err);
        }
        flagged++;
        continue;
      }

      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.CAMPAIGNS,
          Key: { PK: camp.PK, SK: camp.SK },
          UpdateExpression: "SET selectedNumbers = :n, updatedAt = :now",
          ExpressionAttributeValues: { ":n": kept, ":now": new Date().toISOString() },
        })
      );
      cleaned++;
    }
  }

  return { cleaned, flagged };
}

