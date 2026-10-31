import { inferRunKeyOffset, toSignedMinutes, fromSignedMinutes } from "../runKeyOffset";

describe("inferRunKeyOffset", () => {
  it("infers Ndays_to_go as N days before, signed positive", () => {
    const r = inferRunKeyOffset("2days_to_go", "19:00");
    expect(r).toEqual({ minutes: 2880, direction: "before" });
  });

  it("infers N_mins_to_go as N minutes before", () => {
    expect(inferRunKeyOffset("20_mins_to_go", "19:00")).toEqual({ minutes: 20, direction: "before" });
  });

  it("infers we_are_live as exactly at start", () => {
    expect(inferRunKeyOffset("we_are_live", "19:00")).toEqual({ minutes: 0, direction: "before" });
  });

  it("infers its_H_pm as at start when it matches the promoted slot", () => {
    expect(inferRunKeyOffset("its_7_pm", "19:00")).toEqual({ minutes: 0, direction: "before" });
  });

  it("infers its_H_MM_pm as AFTER start when the minute component is later", () => {
    // its_7_10_pm against a 7:00pm promoted slot = 10 min after start
    expect(inferRunKeyOffset("its_7_10_pm", "19:00")).toEqual({ minutes: 10, direction: "after" });
  });

  it("infers its_H_MM_am correctly against an AM slot", () => {
    expect(inferRunKeyOffset("its_11_20_am", "11:00")).toEqual({ minutes: 20, direction: "after" });
  });

  it("infers fixed-clock-time run keys against the promoted slot", () => {
    // 9am_groupjoin is a fixed 09:00 same-day clock time — before a 7pm slot
    expect(inferRunKeyOffset("9am_groupjoin", "19:00")).toEqual({ minutes: 600, direction: "before" });
    // ...and still before an 11am slot (9am is 2h before 11am)
    expect(inferRunKeyOffset("9am_groupjoin", "11:00")).toEqual({ minutes: 120, direction: "before" });
    // 3pm_group_join is AFTER an 11am slot (3pm is 4h after 11am)
    expect(inferRunKeyOffset("3pm_group_join", "11:00")).toEqual({ minutes: 240, direction: "after" });
  });

  it("returns null for an unrecognized run key name", () => {
    expect(inferRunKeyOffset("some_custom_key", "19:00")).toBeNull();
  });
});

describe("signed minutes conversion", () => {
  it("round-trips before/after through signed minutes", () => {
    expect(toSignedMinutes(10, "before")).toBe(10);
    expect(toSignedMinutes(10, "after")).toBe(-10);
    expect(fromSignedMinutes(10)).toEqual({ minutes: 10, direction: "before" });
    expect(fromSignedMinutes(-10)).toEqual({ minutes: 10, direction: "after" });
    expect(fromSignedMinutes(0)).toEqual({ minutes: 0, direction: "before" });
  });
});
