import { PhoneNumber } from "../types";
import { FetchedTemplate, Provider, SendParams, SendResult } from "./types";

/**
 * WATI API. Each phone number has its own apiKey + tenant-specific endpoint
 * (e.g. https://live-mt-server.wati.io/12345).
 */
async function sendMessage(params: SendParams): Promise<SendResult> {
  const { phone, templateName, parameters, number } = params;

  if (!number.apiKey || !number.endpoint) {
    return { ok: false, error: "WATI apiKey/endpoint missing on phone number config" };
  }

  try {
    const response = await fetch(
      `${number.endpoint}/api/v1/sendTemplateMessage/${encodeURIComponent(phone)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${number.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template_name: templateName,
          broadcast_name: templateName,
          parameters: parameters.map((value, i) => ({ name: String(i + 1), value })),
        }),
      }
    );

    const data = (await response.json().catch(() => ({}))) as {
      result?: boolean;
      message?: string;
      id?: string;
    };

    if (response.ok && data.result !== false) {
      return { ok: true, messageId: data.id };
    }

    return { ok: false, error: data.message || `WATI send failed (${response.status})` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "WATI request failed" };
  }
}

async function fetchTemplates(number: PhoneNumber): Promise<FetchedTemplate[]> {
  if (!number.apiKey || !number.endpoint) return [];

  const response = await fetch(`${number.endpoint}/api/v1/getMessageTemplates`, {
    headers: { Authorization: `Bearer ${number.apiKey}` },
  });

  if (!response.ok) return [];

  const data = (await response.json()) as {
    messageTemplates?: {
      elementName: string;
      languageCode?: string;
      category?: string;
      status?: string;
      customParams?: unknown[];
    }[];
  };

  return (data.messageTemplates || []).map((t) => ({
    name: t.elementName,
    language: t.languageCode || "en",
    category: t.category || "unknown",
    status: (t.status || "approved").toLowerCase(),
    components: t.customParams || [],
  }));
}

const watiProvider: Provider = { sendMessage, fetchTemplates };
export default watiProvider;
