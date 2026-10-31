import { APIGatewayProxyHandler } from "aws-lambda";
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { getRegistryWorkshop } from "../../lib/workshop-registry";
import { queryLeadsByExactDate } from "../../lib/database-leads";

const MASTERCLASS_TABLE = process.env.MASTERCLASS_TABLE || "masterclass_lookup_key";
const BATCH_GET_SIZE = 100; // DynamoDB BatchGetItem's per-request key cap

interface GroupSelector {
  wsCode: string;
  workshopName: string;
  batchDate: string;
}

interface Lead {
  phone: string;
  name: string;
  email: string;
  workshopName: string;
  batchDate: string;
}

/**
 * Returns the actual registrant rows (not just counts) for a set of
 * wsCode+batchDate selections from Crossale's Pick Date Range step — powers
 * the "Download CSV" button so the team can see exactly who's in the
 * audience before promoting it, same registrant pool crossale/create.ts
 * would build a campaign from (dedup by phone across a workshop's name
 * aliases, one row per real person).
 * POST /crossale/leads
 * { groups: { wsCode, workshopName, batchDate }[], excludePaid? }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const { groups, excludePaid } = JSON.parse(event.body || "{}") as { groups?: GroupSelector[]; excludePaid?: boolean };
    if (!groups?.length) return error(400, "groups is required", origin);

    const leads: Lead[] = [];

    for (const g of groups) {
      const registryWorkshop = await getRegistryWorkshop(g.wsCode);
      if (!registryWorkshop) continue;

      const seenPhones = new Set<string>();
      const perCandidate = await Promise.all(
        registryWorkshop.candidates.map((name) => queryLeadsByExactDate(name, g.batchDate))
      );
      for (const candidateLeads of perCandidate) {
        for (const lead of candidateLeads) {
          if (!lead.phone || seenPhones.has(lead.phone)) continue;
          seenPhones.add(lead.phone);
          leads.push({
            phone: lead.phone,
            name: lead.name || "",
            email: lead.email || "",
            workshopName: g.workshopName,
            batchDate: g.batchDate,
          });
        }
      }
    }

    const result = excludePaid ? await filterOutPaid(leads) : leads;
    return success({ leads: result }, origin);
  } catch (err) {
    console.error("Crossale leads error:", err);
    return error(500, "Failed to load leads", origin);
  }
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Same paid-customer lookup send-worker.ts uses at actual send time
// (masterclass_lookup_key, keyed "PHONE#<phone>" / "EMAIL#<email>" under
// attribute "pk") — matched here via BatchGetItem instead of one GetItem per
// lead, since a batch can be 1000+ registrants and this needs to stay well
// under API Gateway's 29s limit.
async function filterOutPaid(leads: Lead[]): Promise<Lead[]> {
  const paidPhones = new Set<string>();
  for (const phones of chunk(Array.from(new Set(leads.map((l) => l.phone))), BATCH_GET_SIZE)) {
    const res = await docClient.send(
      new BatchGetCommand({ RequestItems: { [MASTERCLASS_TABLE]: { Keys: phones.map((p) => ({ pk: `PHONE#${p}` })) } } })
    );
    for (const item of res.Responses?.[MASTERCLASS_TABLE] || []) {
      const pk = item.pk as string;
      if (pk?.startsWith("PHONE#")) paidPhones.add(pk.slice("PHONE#".length));
    }
  }

  // Email fallback, only for leads a phone match didn't already catch —
  // mirrors send-worker.ts's own fallback order.
  const remaining = leads.filter((l) => !paidPhones.has(l.phone));
  const emails = Array.from(new Set(remaining.map((l) => l.email.trim().toLowerCase()).filter(Boolean)));
  const paidEmails = new Set<string>();
  for (const emailChunk of chunk(emails, BATCH_GET_SIZE)) {
    const res = await docClient.send(
      new BatchGetCommand({ RequestItems: { [MASTERCLASS_TABLE]: { Keys: emailChunk.map((e) => ({ pk: `EMAIL#${e}` })) } } })
    );
    for (const item of res.Responses?.[MASTERCLASS_TABLE] || []) {
      const pk = item.pk as string;
      if (pk?.startsWith("EMAIL#")) paidEmails.add(pk.slice("EMAIL#".length));
    }
  }

  return leads.filter((l) => !paidPhones.has(l.phone) && !paidEmails.has(l.email.trim().toLowerCase()));
}
