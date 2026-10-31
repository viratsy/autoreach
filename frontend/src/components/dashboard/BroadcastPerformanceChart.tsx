"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { DailyBreakdownPoint } from "@/types";

interface Props {
  data?: DailyBreakdownPoint[];
}

/** "2026-07-16" -> "16 Jul" — matches the reference mockup's axis labels. */
function formatDay(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[m - 1]}`;
}

export default function BroadcastPerformanceChart({ data }: Props) {
  const points = data || [];

  if (points.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Broadcast Performance</h3>
        <p className="text-sm text-gray-400 text-center py-16">No campaign activity in this period yet.</p>
      </div>
    );
  }

  const chartData = points.map((p) => ({ ...p, label: formatDay(p.date) }));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Broadcast Performance</h3>
        {/* Real data note: each campaign's lifetime totals are bucketed onto its
            creation day (no per-day message index exists), so a long-running
            campaign's whole volume shows on one day rather than spread across
            when it actually sent. */}
      </div>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer>
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 12, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12, border: "1px solid #e5e7eb" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="sent" name="Sent" stroke="#16a34a" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="delivered" name="Delivered" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="read" name="Read" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="replied" name="Replied" stroke="#a855f7" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
