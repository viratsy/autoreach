"use client";

import { useState } from "react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Business } from "@/types";
import { Search, CheckCheck, Check, Clock, XCircle, SkipForward, Reply, Send, Eye, MessageSquare } from "lucide-react";

interface TimelineEntry {
  campaignId: string;
  campaignName: string;
  businessName: string;
  templateName: string;
  contactName: string;
  sendingNumberId: string;
  status: string;
  errorCode: string | null;
  sentAt: string;
  updatedAt: string;
  repliedAt: string | null;
}

const STATUS_STYLES: Record<string, { color: string; icon: React.ElementType; label: string }> = {
  queued: { color: "text-gray-400 bg-gray-100", icon: Clock, label: "Queued" },
  sent: { color: "text-blue-600 bg-blue-50", icon: Check, label: "Sent" },
  delivered: { color: "text-teal-600 bg-teal-50", icon: CheckCheck, label: "Delivered" },
  read: { color: "text-green-600 bg-green-50", icon: CheckCheck, label: "Read" },
  failed: { color: "text-red-600 bg-red-50", icon: XCircle, label: "Failed" },
  skipped: { color: "text-orange-500 bg-orange-50", icon: SkipForward, label: "Skipped" },
};

/**
 * Funnel counts over one contact's messages, cumulative the same way the
 * campaign view counts them: a message that reached "read" was also sent and
 * delivered, so it counts toward all three.
 */
function timelineStats(timeline: TimelineEntry[]) {
  const reached = (statuses: string[]) => timeline.filter((t) => statuses.includes(t.status)).length;
  return {
    total: timeline.length,
    sent: reached(["sent", "delivered", "read"]),
    delivered: reached(["delivered", "read"]),
    read: reached(["read"]),
    replied: timeline.filter((t) => t.repliedAt).length,
    failed: reached(["failed"]),
  };
}

function StatsPanel({ timeline }: { timeline: TimelineEntry[] }) {
  const s = timelineStats(timeline);
  const pct = (n: number) => (s.total ? Math.round((n / s.total) * 100) : 0);
  const rows = [
    { label: "Sent", value: s.sent, icon: Send, color: "text-blue-600", bar: "bg-blue-500" },
    { label: "Delivered", value: s.delivered, icon: CheckCheck, color: "text-teal-600", bar: "bg-teal-500" },
    { label: "Read", value: s.read, icon: Eye, color: "text-green-600", bar: "bg-green-500" },
    { label: "Replied", value: s.replied, icon: MessageSquare, color: "text-indigo-600", bar: "bg-indigo-500" },
    ...(s.failed ? [{ label: "Failed", value: s.failed, icon: XCircle, color: "text-red-600", bar: "bg-red-500" }] : []),
  ];
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs text-gray-500">Messages</p>
      <p className="text-2xl font-bold text-gray-900 mb-3">{s.total}</p>
      <div className="space-y-3">
        {rows.map(({ label, value, icon: Icon, color, bar }) => (
          <div key={label}>
            <div className="flex items-center justify-between text-sm">
              <span className={`flex items-center gap-1.5 font-medium ${color}`}>
                <Icon className="w-4 h-4" /> {label}
              </span>
              <span className="text-gray-900 font-semibold">
                {value} <span className="text-xs font-normal text-gray-400">{pct(value)}%</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct(value)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ContactTimelinePage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [phone, setPhone] = useState("");
  const [searchedPhone, setSearchedPhone] = useState("");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const numberById = new Map(businesses.flatMap((b) => b.phoneNumbers.map((pn) => [pn.phoneNumberId, pn])));

  const search = async () => {
    const digits = phone.replace(/\D/g, "");
    if (!digits) return;
    setLoading(true);
    setSearched(true);
    try {
      const [bizData, data] = await Promise.all([
        businesses.length === 0 ? apiRequest<{ businesses: Business[] }>("/businesses") : Promise.resolve({ businesses }),
        apiRequest<{ phone: string; timeline: TimelineEntry[] }>(`/messages/by-phone?phone=${digits}`),
      ]);
      setBusinesses(bizData.businesses);
      setTimeline(data.timeline);
      setSearchedPhone(digits);
    } catch {
      setTimeline([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthGuard>
      <AppShell>
        <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        <div className="max-w-3xl w-full min-w-0">
          <h2 className="text-2xl font-bold text-gray-900 mb-1">Contact Timeline</h2>
          <p className="text-sm text-gray-500 mb-6">
            Every campaign message ever sent to one recipient, in order, with its delivery status.
          </p>

          <div className="flex gap-2 mb-6">
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="919650636663 (with country code, no +)"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            <button
              onClick={search}
              disabled={!phone.trim() || loading}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-primary-700"
            >
              <Search className="w-4 h-4" /> {loading ? "Searching..." : "Search"}
            </button>
          </div>

          {searched && !loading && timeline.length === 0 && (
            <p className="text-sm text-gray-400 py-6 text-center">
              No campaign messages found for +{searchedPhone}.
            </p>
          )}

          {timeline.length > 0 && (
            <p className="text-xs text-gray-500 mb-4">
              <span className="font-medium text-gray-900">{timeline.length}</span> message
              {timeline.length === 1 ? "" : "s"} to +{searchedPhone}
              {(() => {
                const replies = timeline.filter((t) => t.repliedAt).length;
                const read = timeline.filter((t) => t.status === "read").length;
                const failed = timeline.filter((t) => t.status === "failed").length;
                const bits = [];
                if (read) bits.push(`${read} read`);
                if (replies) bits.push(`${replies} replied`);
                if (failed) bits.push(`${failed} failed`);
                return bits.length ? ` · ${bits.join(" · ")}` : "";
              })()}
            </p>
          )}

          {timeline.length > 0 && (
            <div className="lg:hidden mb-5">
              <StatsPanel timeline={timeline} />
            </div>
          )}

          {timeline.length > 0 && (
            <div className="relative border-l-2 border-gray-100 ml-3 space-y-5">
              {timeline.map((t, i) => {
                const style = STATUS_STYLES[t.status] || { color: "text-gray-400 bg-gray-100", icon: Clock, label: t.status };
                const Icon = style.icon;
                const number = numberById.get(t.sendingNumberId);
                return (
                  <div key={`${t.campaignId}-${i}`} className="relative pl-6">
                    <div className={`absolute -left-[9px] top-0.5 w-4 h-4 rounded-full flex items-center justify-center ${style.color}`}>
                      <Icon className="w-2.5 h-2.5" />
                    </div>
                    <div className="bg-white border border-gray-200 rounded-xl p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-900">{t.campaignName}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${style.color}`}>{style.label}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {t.businessName} · {t.templateName}
                        {number && <> · from {number.displayName} ({number.displayNumber})</>}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        {t.sentAt ? new Date(t.sentAt).toLocaleString() : ""}
                        {t.errorCode && <span className="text-red-500"> · error {t.errorCode}</span>}
                      </p>
                      {t.repliedAt && (
                        <p className="text-xs text-primary-600 mt-1 flex items-center gap-1">
                          <Reply className="w-3 h-3" /> Replied {new Date(t.repliedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pinned beside the timeline so the totals stay in view however far
            down the message list you scroll. Small screens get the inline copy above. */}
        {timeline.length > 0 && (
          <aside className="hidden lg:block w-64 shrink-0 sticky top-6 mt-[9.5rem]">
            <StatsPanel timeline={timeline} />
          </aside>
        )}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
