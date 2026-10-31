// Run key names encode a real intended send schedule (e.g. "its_7_10_pm" =
// 7:10pm, 10 minutes AFTER a 7pm start; "2days_to_go" = 2 days before). This
// infers the intended offset from the name so Crossale doesn't default
// everything to "0 days before" for run keys nobody has manually configured
// yet. Confirmed with the team:
//  - its_H(_MM)_am/pm and Xam_groupjoin/Xpm_group_join/the_day_is_here can
//    land AFTER the workshop start, not just before — offsetMinutes is
//    signed (negative = after) both here and in campaign-factory's
//    `sendMoment = promotedMoment - offsetMinutes` math, which already
//    supported negative values with no backend changes needed.
//  - Xam_groupjoin / Xpm_group_join / the_day_is_here are a FIXED clock time
//    on the promoted date itself, not a fixed duration before/after start —
//    so unlike its_* they need the promoted slot to resolve to an offset.

export type OffsetDirection = "before" | "after";

export interface InferredOffset {
  minutes: number; // unsigned magnitude
  direction: OffsetDirection;
}

// Fixed clock time (24h "HH:MM") on the promoted date, regardless of the
// session's own start time. "the_day_is_here" defaults to 8:00 AM as a
// same-day-early reminder — editable like any other inferred value.
const FIXED_CLOCK_TIMES: Record<string, string> = {
  "9am_groupjoin": "09:00",
  "1pm_group_join": "13:00",
  "3pm_group_join": "15:00",
  the_day_is_here: "08:00",
};

function toMinutesSinceMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

function fromClockDiff(targetHHMM: string, promotedTime: string): InferredOffset {
  const diff = toMinutesSinceMidnight(promotedTime) - toMinutesSinceMidnight(targetHHMM);
  return diff >= 0 ? { minutes: diff, direction: "before" } : { minutes: -diff, direction: "after" };
}

function parseItsClock(runKey: string): string | null {
  // its_7_pm, its_7_10_pm, its_11_am, its_11_20_am
  const m = runKey.match(/^its_(\d{1,2})(?:_(\d{1,2}))?_(am|pm)$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const isPM = m[3] === "pm";
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Infers an offset from a run key's name, relative to the chosen promoted
 * slot ("HH:MM" 24h). Returns null when the name doesn't match any known
 * pattern — caller should fall back to whatever's already saved (or 0).
 */
export function inferRunKeyOffset(runKey: string, promotedTime: string): InferredOffset | null {
  const daysMatch = runKey.match(/^(\d+)days?_to_go$/);
  if (daysMatch) return { minutes: parseInt(daysMatch[1], 10) * 1440, direction: "before" };

  const minsMatch = runKey.match(/^(\d+)_?mins?_to_go$/);
  if (minsMatch) return { minutes: parseInt(minsMatch[1], 10), direction: "before" };

  if (runKey === "we_are_live") return { minutes: 0, direction: "before" };

  const itsClock = parseItsClock(runKey);
  if (itsClock) return fromClockDiff(itsClock, promotedTime);

  const fixedClock = FIXED_CLOCK_TIMES[runKey];
  if (fixedClock) return fromClockDiff(fixedClock, promotedTime);

  return null;
}

export function toSignedMinutes(minutes: number, direction: OffsetDirection): number {
  return direction === "before" ? minutes : -minutes;
}

export function fromSignedMinutes(signed: number): InferredOffset {
  return signed < 0 ? { minutes: -signed, direction: "after" } : { minutes: signed, direction: "before" };
}
