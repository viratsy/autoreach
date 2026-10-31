/**
 * Known Meta WhatsApp Cloud API error codes and whether retrying makes sense.
 * Sourced from Meta's official error code reference:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes/
 * (Message-send-relevant sections only — template creation, phone registration,
 * and Marketing Messages API-only codes are omitted since they can't appear as
 * a per-contact message failure in this app.)
 *
 * Two different code paths store a failed message's reason in different formats:
 * send-worker.ts (immediate API failure) stores Meta's error *message* text; the
 * async delivery-failure webhook (webhook-worker.ts's processStatusUpdate) stores
 * the bare numeric *code*. Classifying by phrase-matching alone (see retry-failed.ts)
 * can never match a bare number, so this map is checked first against the numeric
 * code — falling back to phrase matching only for free-text messages.
 *
 * retryable: true means "worth retrying" (transient, or something the operator may
 * have since fixed, e.g. billing) — not "guaranteed to succeed."
 */
export const META_ERROR_CODES: Record<string, { retryable: boolean; label: string }> = {
  // ── Authorization ──────────────────────────────────────────────────────
  "0": { retryable: false, label: "Unable to authenticate the app user — access token needs replacing" },
  "3": { retryable: false, label: "Capability or permissions issue on this app/token" },
  "10": { retryable: false, label: "Permission not granted or has been removed" },
  "190": { retryable: false, label: "Access token has expired" },
  "200": { retryable: false, label: "No access token was provided" },

  // ── Integrity (account-level restrictions) ────────────────────────────
  "368": { retryable: false, label: "WhatsApp Business Account restricted or disabled for a policy violation" },
  "130497": { retryable: false, label: "WhatsApp Business Account restricted from messaging users in this country" },
  "131031": { retryable: false, label: "Account restricted or disabled — policy violation or failed data verification" },

  // ── Throttling ─────────────────────────────────────────────────────────
  "4": { retryable: true, label: "App has reached its API call rate limit" },
  "80007": { retryable: true, label: "WhatsApp Business Account rate limit reached" },
  "130429": { retryable: true, label: "Cloud API message throughput limit reached" },
  "131048": { retryable: false, label: "Message restricted — recipient blocked or messages flagged as spam" },
  "131056": { retryable: true, label: "Too many messages sent to the same recipient in a short period" },
  "131064": { retryable: true, label: "Messaging limit reached due to template classification violations (auto-lifts)" },
  "133016": { retryable: true, label: "Too many registration/deregistration attempts in a short period" },

  // ── General send errors ────────────────────────────────────────────────
  "1": { retryable: true, label: "Invalid request or possible server error" },
  "2": { retryable: true, label: "Temporary downtime or server overload" },
  "33": { retryable: false, label: "Business phone number has been deleted" },
  "100": { retryable: false, label: "Request includes an unsupported or misspelled parameter" },
  "130403": { retryable: false, label: "Business has blocked this end user on WhatsApp" },
  "130472": { retryable: false, label: "Message not sent as part of a marketing message experiment" },
  "131000": { retryable: true, label: "Message failed to send due to an unknown error" },
  "131005": { retryable: false, label: "Permission not granted or has been removed" },
  "131008": { retryable: false, label: "Request is missing a required parameter" },
  "131009": { retryable: false, label: "One or more parameter values are invalid" },
  "131016": { retryable: true, label: "Service temporarily unavailable" },
  "131021": { retryable: false, label: "Sender and recipient phone number are the same" },
  "131026": { retryable: false, label: "Not on WhatsApp, using an old WhatsApp version, or hasn't accepted new Terms of Service" },
  "131037": { retryable: false, label: "Business phone number lacks an approved display name" },
  "131042": { retryable: true, label: "Payment issue — verify billing setup and credit line status" },
  "131045": { retryable: false, label: "Phone number registration error" },
  "131047": { retryable: true, label: "More than 24 hours since the recipient last replied (send a template instead)" },
  "131049": { retryable: true, label: "Not delivered for ecosystem engagement health reasons — wait 24 hours before resending" },
  "131050": { retryable: false, label: "Recipient has stopped receiving marketing messages — do not retry" },
  "131051": { retryable: false, label: "Unsupported message type" },
  "131052": { retryable: false, label: "Unable to download media sent by the user" },
  "131053": { retryable: false, label: "Unable to upload media used in the message" },
  "131057": { retryable: true, label: "Business Account is in maintenance mode" },
  "131063": { retryable: false, label: "Template categorized as Marketing but disabled on Cloud API" },
  "132000": { retryable: true, label: "Number of variable parameter values does not match the template definition" },
  "132001": { retryable: true, label: "Template does not exist or is not approved" },
  "132005": { retryable: true, label: "Template hydration failed — translated text too long" },
  "132007": { retryable: false, label: "Template content violates WhatsApp policy" },
  "132012": { retryable: true, label: "Variable parameter values are formatted incorrectly" },
  "132015": { retryable: true, label: "Template paused due to low quality" },
  "132016": { retryable: true, label: "Template permanently disabled due to repeated low-quality pauses" },
  "132068": { retryable: false, label: "Flow is in a blocked state" },
  "132069": { retryable: true, label: "Flow throttled — too many messages sent in the last hour" },
  "133000": { retryable: false, label: "Previous deregistration attempt failed" },
  "133004": { retryable: true, label: "Server temporarily unavailable" },
  "133005": { retryable: false, label: "Two-step verification PIN incorrect" },
  "133006": { retryable: false, label: "Phone number needs verification before registering" },
  "133008": { retryable: true, label: "Too many two-step verification PIN guesses — retry after the cooldown" },
  "133009": { retryable: true, label: "Two-step verification PIN entered too quickly — retry after a short wait" },
  "133010": { retryable: false, label: "Phone number is not registered on the WhatsApp platform" },
  "133015": { retryable: true, label: "Phone number was recently deleted — wait a few minutes before retrying" },
  "134011": { retryable: false, label: "WhatsApp Payments terms of service acceptance pending" },
  "135000": { retryable: false, label: "Unknown error with request parameters" },
};

/** Extracts a known numeric error code from a raw errorCode value, whether it's
 * already bare ("131042") or embedded in Meta's message text ("(#131042) ..."). */
export function extractKnownErrorCode(errorCode: string): string | null {
  const match = errorCode.match(/\d{3,6}/);
  if (match && META_ERROR_CODES[match[0]]) return match[0];
  return null;
}

// Phrase-matching fallback for free-text errors with no recognized numeric
// code embedded — used by both retry-failed.ts (to decide what to actually
// queue) and get.ts (to tell the UI which failure reasons are worth offering
// a retry on at all).
export const NON_RETRYABLE_ERRORS = [
  "not a valid whatsapp",
  "recipient is not a valid",
  "incapable of receiving",
  "number does not exist",
  "invalid recipient",
  "not registered",
  "deregistered",
  "unavailable",
  "blocked",
  "spam",
];

export const RETRYABLE_ERRORS = [
  "rate limit",
  "template",
  "param",
  "payment",
  "insufficient",
  "timeout",
  "internal",
  "temporarily",
  "try again",
];

/** Same three-tier classification retry-failed.ts applies per-message, collapsed
 * to a plain boolean for display purposes (an "unrecognized" error is, like a
 * non-retryable one, never actually queued — so both read as false here). */
export function classifyErrorRetryable(rawErrorCode: string): boolean {
  const knownCode = extractKnownErrorCode(rawErrorCode);
  if (knownCode) return META_ERROR_CODES[knownCode].retryable;

  const lower = rawErrorCode.toLowerCase();
  if (NON_RETRYABLE_ERRORS.some((e) => lower.includes(e))) return false;
  if (RETRYABLE_ERRORS.some((e) => lower.includes(e))) return true;
  return false;
}
