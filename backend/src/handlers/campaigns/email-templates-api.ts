import { APIGatewayProxyHandler } from "aws-lambda";
import { PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { randomBytes } from "crypto";
import { docClient } from "../../lib/dynamo";
import { success, error, options } from "../../lib/response";
import { getAuthEmail } from "../../lib/auth";
import { listEmailTemplates, getEmailTemplateById, EmailTemplate } from "../../lib/email-templates";

const TABLE = process.env.EMAIL_LIBRARY_TABLE!;

/** Readable id derived from the name, so rows stay identifiable in the table. */
function makeId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  return `${slug || "email"}_${randomBytes(3).toString("hex")}`;
}

/**
 * The standalone email template library.
 *
 * GET    /email-templates → list
 * PUT    /email-templates → create (no templateId) or update one
 * DELETE /email-templates → remove one { templateId }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);
  if (!getAuthEmail(event)) return error(401, "Unauthorized", origin);

  try {
    if (event.httpMethod === "GET") {
      return success({ templates: await listEmailTemplates() }, origin);
    }

    const body = JSON.parse(event.body || "{}") as Partial<EmailTemplate>;
    const templateId = (body.templateId || "").trim();

    if (event.httpMethod === "DELETE") {
      if (!templateId) return error(400, "templateId is required", origin);
      await docClient.send(new DeleteCommand({ TableName: TABLE, Key: { templateId } }));
      return success({ deleted: templateId }, origin);
    }

    const name = (body.name || "").trim();
    const subject = (body.subject || "").trim();
    const text = body.body || "";

    if (!name || !subject || !text.trim()) {
      return error(400, "name, subject and body are required", origin);
    }

    // Recomputed here rather than trusted from the client — the send path uses
    // this list to decide whether a contact has every value the copy needs, so
    // a stale or hand-edited list would let broken emails through.
    const params = [
      ...new Set(
        [...subject.matchAll(/\{\{([a-z_]+)\}\}/g)]
          .map((m) => m[1])
          .concat([...text.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]))
      ),
    ].sort();

    // Preserve legacy run-key matching on update: campaigns created before the
    // picker rely on it, and silently dropping it would stop them emailing.
    const existing = templateId ? await getEmailTemplateById(templateId, true) : null;

    const item: EmailTemplate = {
      templateId: templateId || makeId(name),
      name,
      subject,
      body: text,
      params,
      runKeys: body.runKeys ?? existing?.runKeys ?? [],
      enabled: body.enabled !== false,
      updatedAt: new Date().toISOString(),
    };

    await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
    return success({ template: item }, origin);
  } catch (err) {
    console.error("[email-templates] failed", err);
    return error(500, err instanceof Error ? err.message : "Failed", origin);
  }
};
