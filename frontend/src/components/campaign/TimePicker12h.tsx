"use client";

import { useEffect } from "react";

// Native <input type="time"> displays in 12h or 24h based on the browser/OS locale,
// not anything the page controls — so a real 12-hour picker needs its own UI.
// Value in/out stays a 24h "HH:MM" string (what the backend/API already expects);
// only the display is 12-hour AM/PM.

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

interface Parsed {
  hour12: number;
  minute: number;
  period: "AM" | "PM";
}

function parse24h(value: string): Parsed {
  if (!value) return { hour12: 12, minute: 0, period: "PM" };
  const [h, m] = value.split(":").map(Number);
  const period: "AM" | "PM" = h >= 12 ? "PM" : "AM";
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute: m || 0, period };
}

function to24h({ hour12, minute, period }: Parsed): string {
  let h = hour12 % 12;
  if (period === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export default function TimePicker12h({ value, onChange, className = "" }: Props) {
  const parsed = parse24h(value);

  // If nothing's been picked yet, sync the parent to the default we're showing
  // (12:00 PM) — otherwise the field displays a time but the underlying value
  // stays empty, and anything gating on "has a time been set" never clears.
  useEffect(() => {
    if (!value) onChange(to24h(parsed));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (patch: Partial<Parsed>) => {
    onChange(to24h({ ...parsed, ...patch }));
  };

  return (
    <div
      className={`flex items-center gap-1 border border-gray-300 rounded-lg px-2 bg-white focus-within:border-primary-400 focus-within:ring-1 focus-within:ring-primary-400 ${className}`}
    >
      <select
        value={parsed.hour12}
        onChange={(e) => update({ hour12: Number(e.target.value) })}
        className="text-sm bg-transparent outline-none py-2"
        aria-label="Hour"
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
      <span className="text-gray-400">:</span>
      <select
        value={parsed.minute}
        onChange={(e) => update({ minute: Number(e.target.value) })}
        className="text-sm bg-transparent outline-none py-2"
        aria-label="Minute"
      >
        {MINUTES.map((m) => (
          <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
        ))}
      </select>
      <select
        value={parsed.period}
        onChange={(e) => update({ period: e.target.value as "AM" | "PM" })}
        className="text-sm bg-transparent outline-none py-2 font-medium text-gray-600 ml-1"
        aria-label="AM or PM"
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}
