/**
 * Sorts a campaign reply into one of three buckets so the Replied drill-down
 * can separate real intent from noise:
 *
 *  - "button": the contact tapped a quick-reply button on the template.
 *  - "auto":   a WhatsApp Business auto-reply / greeting message fired by the
 *              recipient's own account ("Thank you for contacting…", menus,
 *              catalogue links). On a broad broadcast these are the majority
 *              of "replies" and say nothing about interest.
 *  - "other":  anything else — a human typing, including opt-outs.
 *
 * Auto-reply detection is a guess from two independent signals:
 *  1. Timing — greeting messages fire within seconds of delivery. Measured on
 *     a 45k-contact campaign: ~82% of auto-replies landed within 30s of the
 *     send, against ~6% of button taps (humans need time to read first).
 *  2. Wording — the stock phrases WhatsApp Business greeting messages use.
 */

export type ReplyType = "button" | "auto" | "other";

export const REPLY_TYPES: ReplyType[] = ["button", "auto", "other"];

/** A reply landing this soon after the send is treated as machine-generated. */
const AUTO_REPLY_MAX_SECONDS = 20;

/** Long, formatted blurbs (menus, catalogues, address cards) are never typed live. */
const AUTO_REPLY_MIN_LENGTH = 250;

const AUTO_PATTERNS = new RegExp(
  [
    String.raw`thank(s|\s*you|\s*u|you)\s*(so much\s*)?(for|4)\s*(contacting|your (message|enquiry|inquiry|interest)|reaching|connecting|choosing|messaging|texting|getting in touch|writing|approaching|the message)`,
    String.raw`thank(s|\s*you)\s*(for\s*)?contact`,
    String.raw`we('|’)?re (currently )?(unavailable|away|closed|offline)`,
    String.raw`(temporarily|currently) closed|closed for the day|out of (the )?office|business hours`,
    String.raw`will (respond|reply|revert|get back|contact you|reach (out to )?you|call you)`,
    String.raw`(revert|get back to you|respond to you) (soon|shortly|at the earliest|as soon)`,
    String.raw`(we|i) will be (right )?back|be with you shortly|hold on a moment`,
    String.raw`please (let us know|tell us) how (we|i) (can|could|may) (help|assist)`,
    String.raw`how (can|could|may) (we|i) (help|assist) you`,
    String.raw`welcome to|greetings from|glad to connect|thrilled to have you`,
    String.raw`auto(matic)?[\s-]?(reply|msg|message|response)`,
    String.raw`no longer active|number (has )?changed|new (calling )?number is`,
    String.raw`join (our|my|the)\s*(whatsapp\s*)?(group|community|channel)|follow (us|our)|save (our|my) (contact|number)`,
    String.raw`whatsapp\.com/channel|wa\.me/c/|instagram\.com|facebook\.com|maps\.app\.goo\.gl`,
    String.raw`visit (our )?(store|showroom|website)|for (ad )?booking`,
    // Regional-language greeting messages ("welcome", "thanks for contacting").
    String.raw`स्वागत|संपर्क (करने|केल्याबद्दल|साधल्याबद्दल)|ధన్యవాద|স্বাগত|സ്വാഗതം|સ્વાગત|સંપર્ક|வரவேற்கிறது|தொடர்பு கொண்டதற்கு`,
  ].join("|"),
  "i"
);

/** Short human opt-outs that can come back fast but are never auto-replies. */
const OPT_OUT = /^\W*(stop|unsubscribe|not interested|no|block|remove)\b/i;

export function classifyReply(params: {
  text: string;
  isButton: boolean;
  /** When the campaign message was sent (ISO). */
  sentAt?: string | null;
  /** When this reply arrived (ISO). */
  repliedAt: string;
}): ReplyType {
  const { text, isButton, sentAt, repliedAt } = params;
  if (isButton) return "button";

  const body = (text || "").trim();
  if (AUTO_PATTERNS.test(body) || body.length >= AUTO_REPLY_MIN_LENGTH) return "auto";

  if (sentAt && !OPT_OUT.test(body)) {
    const seconds = (Date.parse(repliedAt) - Date.parse(sentAt)) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= AUTO_REPLY_MAX_SECONDS) return "auto";
  }

  return "other";
}

const RANK: Record<ReplyType, number> = { auto: 0, other: 1, button: 2 };

/**
 * A contact can reply several times to one message — typically an instant
 * auto-reply followed later by a human tapping the button. The strongest
 * signal wins: button > other (a human typed) > auto.
 */
export function mergeReplyType(existing: ReplyType | null | undefined, next: ReplyType): ReplyType {
  if (!existing || !(existing in RANK)) return next;
  return RANK[next] > RANK[existing] ? next : existing;
}

/** Kept short — it's for a CSV column and a table cell, not a transcript. */
export const REPLY_TEXT_MAX = 1000;

export function appendReplyText(existing: string | null | undefined, next: string): string {
  const joined = existing ? `${existing} | ${next}` : next;
  return joined.slice(0, REPLY_TEXT_MAX);
}
