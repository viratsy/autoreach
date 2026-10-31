"use client";

import { useState } from "react";
import { Send, CheckCheck, Eye, MessageCircle, ArrowUp, ArrowDown } from "lucide-react";
import { MessageVolumeWindow, WindowKey } from "@/types";

interface Props {
  stats?: Record<WindowKey, MessageVolumeWindow>;
  previousStats?: Record<WindowKey, MessageVolumeWindow>;
  selected: WindowKey;
  onSelect: (key: WindowKey) => void;
}

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "last7Days", label: "Last 7 Days" },
  { key: "last15Days", label: "Last 15 Days" },
  { key: "last30Days", label: "Last 30 Days" },
];

const cards = [
  { key: "sent", label: "Sent", icon: Send, color: "text-blue-600 bg-blue-50" },
  { key: "delivered", label: "Delivered", icon: CheckCheck, color: "text-emerald-600 bg-emerald-50" },
  { key: "read", label: "Read", icon: Eye, color: "text-primary-600 bg-primary-50" },
  { key: "replied", label: "Replied", icon: MessageCircle, color: "text-purple-600 bg-purple-50" },
] as const;

const EMPTY: MessageVolumeWindow = { sent: 0, delivered: 0, read: 0, replied: 0 };

/** Real trend vs the equivalent preceding period — null when there's nothing
 * honest to compare against (both periods zero), so the card just omits the
 * arrow rather than showing a misleading "0%" or divide-by-zero artifact. */
function trendPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? null : null; // no fabricated "∞%" — omit
  return ((current - previous) / previous) * 100;
}

export default function MessageVolumeStats({ stats, previousStats, selected, onSelect }: Props) {
  const values = stats?.[selected] || EMPTY;
  const previous = previousStats?.[selected] || EMPTY;

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-700">Message Volume</h3>
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => onSelect(w.key)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                selected === w.key
                  ? "bg-white text-gray-900 shadow-sm font-medium"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => {
          const current = values[card.key];
          const prev = previous[card.key];
          const pct = trendPct(current, prev);
          return (
            <div key={card.key} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${card.color}`}>
                    <card.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{current.toLocaleString()}</p>
                    <p className="text-xs text-gray-500">{card.label}</p>
                  </div>
                </div>
              </div>
              {pct !== null && (
                <p
                  className={`text-xs mt-2 flex items-center gap-0.5 font-medium ${
                    pct >= 0 ? "text-emerald-600" : "text-red-500"
                  }`}
                >
                  {pct >= 0 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                  {Math.abs(pct).toFixed(1)}% vs previous period
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
