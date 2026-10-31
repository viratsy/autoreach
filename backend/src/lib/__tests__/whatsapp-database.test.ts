import { parseWorkshopDateString } from "../whatsapp-database";

describe("parseWorkshopDateString", () => {
  it("parses a real WhatsAppDatabase pre_date string", () => {
    const result = parseWorkshopDateString("Sunday, 9 Aug 2026, 07:00 pm IST");
    expect(result).not.toBeNull();
    expect(result!.dateYMD).toBe("2026-08-09");
    expect(result!.timeLabel).toBe("07:00 PM IST");
    expect(result!.timeShortLabel).toBe("7 PM");
    expect(result!.endTimeLabel).toBe("10:00 PM");
    // 7:00 PM IST = 13:30 UTC
    expect(result!.instant.toISOString()).toBe("2026-08-09T13:30:00.000Z");
  });

  it("parses a real WhatsAppDatabase Date string with a different day/time", () => {
    const result = parseWorkshopDateString("Wednesday, 12 Aug 2026, 07:00 pm IST");
    expect(result).not.toBeNull();
    expect(result!.dateYMD).toBe("2026-08-12");
    expect(result!.instant.toISOString()).toBe("2026-08-12T13:30:00.000Z");
  });

  it("handles an AM time with non-zero minutes", () => {
    const result = parseWorkshopDateString("Monday, 1 Jun 2026, 11:10 am IST");
    expect(result).not.toBeNull();
    expect(result!.timeLabel).toBe("11:10 AM IST");
    expect(result!.timeShortLabel).toBe("11:10 AM");
    // 11:10 AM IST = 05:40 UTC
    expect(result!.instant.toISOString()).toBe("2026-06-01T05:40:00.000Z");
  });

  it("handles 12 pm (noon) and 12 am (midnight) correctly", () => {
    const noon = parseWorkshopDateString("Monday, 1 Jun 2026, 12:00 pm IST");
    expect(noon!.instant.toISOString()).toBe("2026-06-01T06:30:00.000Z");

    const midnight = parseWorkshopDateString("Monday, 1 Jun 2026, 12:00 am IST");
    expect(midnight!.instant.toISOString()).toBe("2026-05-31T18:30:00.000Z");
  });

  it("returns null for an unrecognized format", () => {
    expect(parseWorkshopDateString("")).toBeNull();
    expect(parseWorkshopDateString("2026-08-12")).toBeNull();
    expect(parseWorkshopDateString("garbage")).toBeNull();
  });
});
