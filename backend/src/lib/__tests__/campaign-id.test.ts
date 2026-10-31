import { generateCampaignId, buildCampaignName } from "../campaign-id";

describe("generateCampaignId", () => {
  it("sanitizes the prefix and appends a 6-char suffix", () => {
    const id = generateCampaignId("AICA B22_Main_1st Reminder");
    expect(id).toMatch(/^aica_b22_main_1st_reminder_[0-9a-f]{6}$/);
  });

  // Hyphens are in the allowed set, so they survive sanitizing; only the runs
  // of substituted characters collapse.
  it("collapses runs of separators and trims the edges", () => {
    expect(generateCampaignId("  Power BI 11 AM  ")).toMatch(/^power_bi_11_am_[0-9a-f]{6}$/);
    expect(generateCampaignId("a--b")).toMatch(/^a--b_[0-9a-f]{6}$/);
  });
});

describe("buildCampaignName", () => {
  // The id is sanitized, the display name is not — that split is the whole
  // reason duplicate.ts can't just reuse the id as the name.
  it("keeps the prefix's capitals and spaces while taking the id's suffix", () => {
    expect(
      buildCampaignName("AICA B22_Main_1st Reminder", "aica_b22_main_1st_reminder_49925c")
    ).toBe("AICA B22_Main_1st Reminder_49925c");
  });

  it("gives a duplicate the original name with the new suffix", () => {
    const original = "AICA B22_Main_1st Reminder_49925c";
    const prefix = original.split("_").slice(0, -1).join("_");
    const newId = generateCampaignId(prefix);
    const duplicated = buildCampaignName(prefix, newId);

    expect(duplicated).not.toBe(original);
    expect(duplicated.startsWith("AICA B22_Main_1st Reminder_")).toBe(true);
    expect(duplicated).toBe(`AICA B22_Main_1st Reminder_${newId.split("_").pop()}`);
  });

  it("renaming keeps the id's suffix, so the campaign stays the same record", () => {
    const id = "aica_b22_main_1st_reminder_49925c";
    expect(buildCampaignName("AICA B23_ReInvite_Live", id)).toBe("AICA B23_ReInvite_Live_49925c");
  });

  it("returns the prefix alone when the id carries no suffix", () => {
    expect(buildCampaignName("standalone", "standalone")).toBe("standalone");
  });
});
