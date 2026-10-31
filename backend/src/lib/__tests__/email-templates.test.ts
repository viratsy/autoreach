import { renderTemplate, missingParams, normalizeRunKey, toHtml, EmailTemplate } from "../email-templates";

const tpl = (over: Partial<EmailTemplate> = {}): EmailTemplate => ({
  runKey: "we_are_live",
  label: "Workshop now Live",
  subject: "🔴 {{full_workshop_name}} is live",
  body: "Hi {{name}},\n\nJoin: {{zoom_link}}",
  params: ["full_workshop_name", "name", "zoom_link"],
  enabled: true,
  ...over,
});

const row = {
  name: "Arun Shukla",
  full_workshop_name: "AI in MS Office Mastery",
  zoom_link: "https://zoom.us/j/123",
  whatsapp_group: "",
};

describe("renderTemplate", () => {
  it("substitutes the campaign CSV's own columns", () => {
    expect(renderTemplate(tpl().subject, row)).toBe("🔴 AI in MS Office Mastery is live");
    expect(renderTemplate(tpl().body, row)).toBe("Hi Arun Shukla,\n\nJoin: https://zoom.us/j/123");
  });

  // Surrounding text is left alone — only the braces go. A blank *required*
  // value makes missingParams() skip the contact entirely, and the worker
  // substitutes "there" for a blank name, so neither reaches a recipient.
  it("blanks a placeholder with no value rather than printing the braces", () => {
    expect(renderTemplate("Group: {{whatsapp_group}}", row)).toBe("Group: ");
  });

  it("leaves an unknown placeholder untouched", () => {
    expect(renderTemplate("Hi {{Not_A_Column}}", row)).toBe("Hi {{Not_A_Column}}");
  });
});

describe("missingParams", () => {
  // A "join the zoom call now" email with an empty link is worse than not
  // sending — it burns sending reputation on a message that cannot work.
  it("flags a blank link so the contact can be skipped", () => {
    const t = tpl({ params: ["zoom_link", "whatsapp_group"] });
    expect(missingParams(t, row)).toEqual(["whatsapp_group"]);
  });

  it("ignores a missing name — the copy still reads fine without it", () => {
    const t = tpl({ params: ["name", "zoom_link"] });
    expect(missingParams(t, { ...row, name: "" })).toEqual([]);
  });
});

describe("normalizeRunKey", () => {
  // Scheduler-built campaigns carry a clean run key; hand-made ones carry free
  // text like "WE ARE LIVE" or "10mins Post".
  it("matches hand-typed labels to their run key", () => {
    expect(normalizeRunKey("WE ARE LIVE")).toBe("we_are_live");
    expect(normalizeRunKey("60 mins to go")).toBe("60_mins_to_go");
    expect(normalizeRunKey("1 day to go")).toBe("1_day_to_go");
  });

  it("is a no-op on an already-clean key", () => {
    expect(normalizeRunKey("2days_to_go")).toBe("2days_to_go");
  });

  it("handles a missing msg", () => {
    expect(normalizeRunKey(undefined)).toBe("");
  });
});

describe("toHtml", () => {
  it("escapes markup but still linkifies bare URLs", () => {
    const html = toHtml("See <b>this</b>\nhttps://zoom.us/j/1", "");
    expect(html).toContain("&lt;b&gt;this&lt;/b&gt;");
    expect(html).toContain('<a href="https://zoom.us/j/1"');
  });
});
