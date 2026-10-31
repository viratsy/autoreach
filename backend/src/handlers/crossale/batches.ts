import { APIGatewayProxyHandler } from "aws-lambda";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { listRegistryWorkshops } from "../../lib/workshop-registry";
import { queryLeadsByDateRange } from "../../lib/database-leads";

interface BatchGroup {
  wsCode: string;
  workshopName: string;
  firstBatchDate: string;
  total: number;
}

/**
 * Lists past workshop batches whose workshop date falls within a date
 * range — the audience picker for Crossale. Queries the real registration
 * database (the `database` table — 200K+ rows across every workshop ever
 * run) via the workshop_name-workshop_date_ymd-index GSI, once per known
 * workshop (from the workshop registry) and each of its name aliases —
 * never a full table scan, which at this table's size would blow past API
 * Gateway's 29s limit.
 *
 * Multiple registry codes (e.g. a workshop run at two different times of
 * day, like "Power BI 7 PM" / "Power BI 11AM") can share one whatsappDbName
 * — the base name real leads are actually captured under. Querying each
 * code separately would re-pull and re-display that SAME underlying lead
 * pool once per code, looking like duplicated data (identical batch counts
 * under two different labels) even though it's one real audience. Grouped
 * by whatsappDbName instead, so Crossale's picker shows one row per real
 * pool of registrants — which exact target/time to promote them to is
 * chosen independently in the next step regardless of which source row
 * they came from.
 * GET /crossale/batches?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    const startDate = event.queryStringParameters?.startDate;
    const endDate = event.queryStringParameters?.endDate;
    if (!startDate || !endDate) {
      return error(400, "startDate and endDate are required", origin);
    }

    const workshops = await listRegistryWorkshops();
    const byBaseName = new Map<string, typeof workshops>();
    for (const ws of workshops) {
      const list = byBaseName.get(ws.whatsappDbName) || [];
      list.push(ws);
      byBaseName.set(ws.whatsappDbName, list);
    }

    const groups: Record<string, BatchGroup> = {};

    await Promise.all(
      Array.from(byBaseName.entries()).map(async ([baseName, members]) => {
        // Deterministic pick so the representative code/label stays stable
        // across requests regardless of Scan ordering.
        const representative = [...members].sort((a, b) => a.code.localeCompare(b.code))[0];
        const candidateSet = new Set(members.flatMap((m) => m.candidates));

        const perCandidateLeads = await Promise.all(
          Array.from(candidateSet).map((name) => queryLeadsByDateRange(name, startDate, endDate))
        );
        for (const leads of perCandidateLeads) {
          for (const lead of leads) {
            if (!lead.workshop_date_ymd) continue;
            const key = `${representative.code}#${lead.workshop_date_ymd}`;
            if (!groups[key]) {
              groups[key] = { wsCode: representative.code, workshopName: baseName, firstBatchDate: lead.workshop_date_ymd, total: 0 };
            }
            groups[key].total++;
          }
        }
      })
    );

    const list = Object.values(groups).sort((a, b) => a.firstBatchDate.localeCompare(b.firstBatchDate));
    return success({ groups: list }, origin);
  } catch (err) {
    console.error("Crossale batches error:", err);
    return error(500, "Failed to list batches", origin);
  }
};
