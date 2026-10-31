import { APIGatewayProxyHandler } from "aws-lambda";
import { suppress, verifyUnsubscribe } from "../../lib/email-suppression";

/**
 * One-click unsubscribe, served off the same short-link domain the calendar
 * links use (l.hardikraja.com / l.navinparmar.in).
 * GET  /u/{token}  — a person clicking the footer link
 * POST /u/{token}  — Gmail/Yahoo's List-Unsubscribe-Post one-click
 *
 * No auth: the token is HMAC-signed, which is what stops someone unsubscribing
 * an address they don't own. Bulk-sender rules require this to work in a single
 * click with no login and no confirmation step.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const token = event.pathParameters?.token || "";
  const email = verifyUnsubscribe(token);

  if (!email) {
    return page(400, "This unsubscribe link isn't valid", "Check that you copied the whole link from the email.");
  }

  try {
    await suppress(email, "unsubscribe");
  } catch (err) {
    console.error("[unsubscribe] failed", err);
    return page(500, "Something went wrong", "Please try again in a moment.");
  }

  // One-click POSTs want a bare 200, not HTML.
  if (event.httpMethod === "POST") {
    return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: "Unsubscribed" };
  }

  return page(
    200,
    "You've been unsubscribed",
    `We won't send any more emails to ${escapeHtml(email)}. You'll still get WhatsApp messages unless you reply STOP there.`
  );
};

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function page(statusCode: number, heading: string, detail: string) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f7f9;margin:0;padding:48px 16px;color:#202124">
<div style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #e3e5e8;border-radius:14px;padding:28px">
<h1 style="font-size:18px;margin:0 0 8px">${heading}</h1>
<p style="font-size:14px;line-height:1.6;color:#5f6368;margin:0">${detail}</p>
</div></body></html>`,
  };
}
