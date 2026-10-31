import { appendReplyText, classifyReply, mergeReplyType, REPLY_TEXT_MAX } from "../reply-classifier";

const SENT = "2026-10-11T04:30:00.000Z";
const after = (seconds: number) => new Date(Date.parse(SENT) + seconds * 1000).toISOString();

describe("classifyReply", () => {
  it("treats a quick-reply button tap as a button reply, even when instant", () => {
    expect(classifyReply({ text: "Yes! I am Intrested!", isButton: true, sentAt: SENT, repliedAt: after(2) })).toBe("button");
  });

  it("flags stock greeting-message wording as auto, regardless of timing", () => {
    const text = "Thank you for contacting Serene Salon & Academy! Please let us know how we can help you.";
    expect(classifyReply({ text, isButton: false, sentAt: SENT, repliedAt: after(3600) })).toBe("auto");
  });

  it("flags an away message as auto", () => {
    const text = "Thank you for your message. We're unavailable right now, but will respond as soon as possible.";
    expect(classifyReply({ text, isButton: false, sentAt: SENT, repliedAt: after(3600) })).toBe("auto");
  });

  it("flags a reply that lands within seconds of the send as auto", () => {
    expect(classifyReply({ text: "Hiii welcome", isButton: false, sentAt: SENT, repliedAt: after(5) })).toBe("auto");
  });

  it("flags long formatted blurbs as auto", () => {
    expect(classifyReply({ text: "x".repeat(300), isButton: false, sentAt: SENT, repliedAt: after(3600) })).toBe("auto");
  });

  it("keeps a fast opt-out as other, not auto", () => {
    expect(classifyReply({ text: "STOP", isButton: false, sentAt: SENT, repliedAt: after(8) })).toBe("other");
  });

  it("keeps a later human reply as other", () => {
    expect(classifyReply({ text: "Is it free ?", isButton: false, sentAt: SENT, repliedAt: after(900) })).toBe("other");
    expect(classifyReply({ text: "Which workshop it is?", isButton: false, sentAt: SENT, repliedAt: after(900) })).toBe("other");
  });

  it("falls back to wording alone without a sentAt", () => {
    expect(classifyReply({ text: "Ok sir", isButton: false, sentAt: null, repliedAt: after(1) })).toBe("other");
  });
});

describe("mergeReplyType", () => {
  it("upgrades an auto-reply once the human taps the button", () => {
    expect(mergeReplyType("auto", "button")).toBe("button");
  });

  it("never downgrades a button tap", () => {
    expect(mergeReplyType("button", "auto")).toBe("button");
    expect(mergeReplyType("button", "other")).toBe("button");
  });

  it("prefers a human reply over an auto-reply", () => {
    expect(mergeReplyType("auto", "other")).toBe("other");
    expect(mergeReplyType("other", "auto")).toBe("other");
  });

  it("takes the new type when there is none yet", () => {
    expect(mergeReplyType(undefined, "auto")).toBe("auto");
  });
});

describe("appendReplyText", () => {
  it("joins successive replies and caps the length", () => {
    expect(appendReplyText("Hi", "Ok")).toBe("Hi | Ok");
    expect(appendReplyText("a".repeat(REPLY_TEXT_MAX), "b")).toHaveLength(REPLY_TEXT_MAX);
  });
});
