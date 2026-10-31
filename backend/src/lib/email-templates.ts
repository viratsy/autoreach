import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

const TABLE = process.env.EMAIL_LIBRARY_TABLE || `autoreach-email-library-${process.env.ENV_NAME || "hardik"}`;

/**
 * A standalone email template, independent of any WhatsApp template or run key.
 *
 * Campaigns pick one explicitly by id while being set up, which is what makes
 * email opt-in: no template is ever matched onto a campaign by accident.
 *
 * `runKeys` exists only for campaigns created before the picker did. Those
 * carry no emailTemplateId, so the worker falls back to finding the template
 * whose runKeys contain their `msg`. New campaigns never use this path, and
 * the field can go once no pre-picker campaign is still scheduled.
 *
 * Placeholders use the campaign CSV's own column names ({{full_workshop_name}},
 * {{zoom_link}}, …) so the values in an email are literally the ones that went
 * out over WhatsApp — they cannot drift apart.
 */
export interface EmailTemplate {
  templateId: string;
  name: string;
  subject: string;
  body: string;
  /** Column names referenced by subject+body, for validation before a send. */
  params: string[];
  /** Legacy run-key matching for campaigns created before the picker. */
  runKeys?: string[];
  enabled: boolean;
  updatedAt?: string;
}

export async function getEmailTemplateById(
  templateId: string,
  includeDisabled = false
): Promise<EmailTemplate | null> {
  if (!templateId) return null;
  const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: { templateId } }));
  const tpl = res.Item as EmailTemplate | undefined;
  if (!tpl) return null;
  return includeDisabled || tpl.enabled !== false ? tpl : null;
}

export async function listEmailTemplates(): Promise<EmailTemplate[]> {
  const items: EmailTemplate[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey }));
    items.push(...((res.Items || []) as EmailTemplate[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Legacy path: find the template that claims this run key.
 *
 * Only used for campaigns that predate the picker. A campaign with an explicit
 * emailTemplateId never reaches here.
 */
export async function findEmailTemplateByRunKey(runKey: string): Promise<EmailTemplate | null> {
  const key = normalizeRunKey(runKey);
  if (!key) return null;
  const all = await listEmailTemplates();
  return all.find((t) => t.enabled !== false && (t.runKeys || []).includes(key)) || null;
}

/**
 * A campaign's `msg` is a clean run key when the scheduler built it, but free
 * text ("WE ARE LIVE", "10mins Post") when someone typed it by hand.
 */
export function normalizeRunKey(msg: string | undefined): string {
  return (msg || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Substitutes {{column}} from a CSV row. Unknown or blank ones become "". */
export function renderTemplate(text: string, row: Record<string, string>): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (_m, key: string) => (row[key] || "").trim());
}

/**
 * Which of a template's placeholders have no value in this row. A blank
 * {{zoom_link}} in a "join now" email is a wasted send, so callers skip the
 * contact rather than mail them a broken message.
 */
export function missingParams(tpl: EmailTemplate, row: Record<string, string>): string[] {
  return tpl.params.filter((p) => p !== "name" && !(row[p] || "").trim());
}

/** Plain text → minimal HTML, preserving the line breaks the copy relies on. */
export function toHtml(body: string, footer: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Bare URLs become links — the copy pastes them raw on their own line.
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#1a73e8;word-break:break-all">$1</a>'
  );
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#202124;max-width:600px;margin:0 auto;padding:16px">',
    `<div style="white-space:pre-wrap">${linked}</div>`,
    footer,
    "</div>",
  ].join("");
}

/**
 * Resolves which template a campaign should send: the one it picked, or — for
 * campaigns created before the picker existed — whichever claims its run key.
 */
export async function resolveTemplateForCampaign(
  emailTemplateId: string | undefined,
  msg: string | undefined,
  includeDisabled = false
): Promise<EmailTemplate | null> {
  if (emailTemplateId) return getEmailTemplateById(emailTemplateId, includeDisabled);
  return findEmailTemplateByRunKey(msg || "");
}
