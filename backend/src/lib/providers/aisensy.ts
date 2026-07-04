import { Provider, SendParams, SendResult } from "./types";

/**
 * AiSensy Campaign API v2. Each phone number has its own apiKey + source label.
 * No public template-list API exists, and no documented message-id field —
 * any 2xx response is treated as "sent".
 */
async function sendMessage(params: SendParams): Promise<SendResult> {
  const { phone, contactName, templateName, parameters, number } = params;

  if (!number.apiKey) {
    return { ok: false, error: "AiSensy apiKey missing on phone number config" };
  }

  try {
    const response = await fetch("https://backend.aisensy.com/campaign/t1/api/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: number.apiKey,
        campaignName: templateName,
        destination: phone,
        userName: contactName || "",
        source: number.source || number.displayName || "",
        templateParams: parameters,
      }),
    });

    if (response.ok) {
      return { ok: true };
    }

    let errMsg = `AiSensy send failed (${response.status})`;
    try {
      const data = (await response.json()) as { message?: string };
      if (data?.message) errMsg = data.message;
    } catch {
      // response wasn't JSON, keep default message
    }
    return { ok: false, error: errMsg };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "AiSensy request failed" };
  }
}

const aisensyProvider: Provider = { sendMessage };
export default aisensyProvider;
