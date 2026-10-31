"use client";

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { MessageVolumeWindow } from "@/types";

interface Props {
  totals?: MessageVolumeWindow & { failed: number; skipped: number; totalContacts: number };
}

const COLORS = {
  replied: "#a855f7",
  read: "#3b82f6",
  delivered: "#10b981",
  sentAwaiting: "#f59e0b",
  failed: "#ef4444",
  pending: "#d1d5db",
};

/**
 * The underlying counters are cumulative through the funnel (deliveredCount
 * already includes messages that progressed to read; readCount already
 * includes replies — confirmed in campaigns/get.ts's own comments), so this
 * can't just plot those counters directly without double-counting. Buckets
 * here are computed as differences to make them mutually exclusive, summing
 * exactly to totalContacts.
 */
export default function MessageBreakdownDonut({ totals }: Props) {
  if (!totals || totals.totalContacts === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Message Breakdown</h3>
        <p className="text-sm text-gray-400 text-center py-16">No campaign activity in this period yet.</p>
      </div>
    );
  }

  const replied = totals.replied;
  const readOnly = Math.max(0, totals.read - totals.replied);
  const deliveredOnly = Math.max(0, totals.delivered - totals.read);
  const sentAwaiting = Math.max(0, totals.sent - totals.failed - totals.delivered);
  const failed = totals.failed;
  const pending = Math.max(0, totals.totalContacts - totals.sent - totals.skipped);

  const data = [
    { name: "Replied", value: replied, color: COLORS.replied },
    { name: "Read", value: readOnly, color: COLORS.read },
    { name: "Delivered", value: deliveredOnly, color: COLORS.delivered },
    { name: "Sent (awaiting delivery)", value: sentAwaiting, color: COLORS.sentAwaiting },
    { name: "Failed", value: failed, color: COLORS.failed },
    { name: "Pending", value: pending, color: COLORS.pending },
  ].filter((d) => d.value > 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="font-semibold text-gray-900 mb-4">Message Breakdown</h3>
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ borderRadius: 8, fontSize: 12, border: "1px solid #e5e7eb" }}
              formatter={(value, name) => {
                const num = typeof value === "number" ? value : Number(value) || 0;
                return [`${num.toLocaleString()} (${((num / totals.totalContacts) * 100).toFixed(1)}%)`, name];
              }}
            />
            <Legend layout="vertical" verticalAlign="middle" align="right" wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
