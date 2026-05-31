"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { ArrowLeft, Send, CheckCircle, Eye, XCircle, MessageSquare } from "lucide-react";

interface CampaignDetail {
  campaignId: string;
  campaignName: string;
  businessName: string;
  selectedNumbers: { phoneNumberId: string; displayName: string }[];
  templateName: string;
  totalContacts: number;
  scheduleDate: string;
  scheduleTime: string;
  status: string;
  createdAt: string;
}

interface Metrics {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replied: number;
}

interface MessageItem {
  phone: string;
  name: string;
  status: string;
  sendingNumber: string;
  errorCode: string | null;
  sentAt: string;
  repliedAt: string | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  "131042": "Payment issue on sending account",
  "131047": "Re-engagement message required (24hr window expired)",
  "131026": "Message undeliverable (number not on WhatsApp)",
  "131051": "Unsupported message type",
  "131053": "Media upload error",
  "132000": "Template parameter count mismatch",
  "132001": "Template does not exist",
  "132005": "Template hydration failed",
  "132012": "Template parameter format mismatch",
  "132015": "Template paused",
  "132016": "Template disabled",
  "133010": "Phone number not registered",
  "130429": "Rate limit hit",
  "131056": "Pair rate limit hit",
  "368": "Temporarily blocked for policy violations",
};

function getErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] || `Error ${code}`;
}

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  scheduled: "bg-yellow-100 text-yellow-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

const msgStatusColors: Record<string, string> = {
  queued: "text-gray-500",
  sent: "text-blue-600",
  delivered: "text-green-600",
  read: "text-purple-600",
  failed: "text-red-600",
};

export default function CampaignViewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-gray-400">Loading...</p></div>}>
      <CampaignViewContent />
    </Suspense>
  );
}

function CampaignViewContent() {
  const searchParams = useSearchParams();
  const campaignId = searchParams?.get("id") || "";
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [cost, setCost] = useState<{ perMessage: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (campaignId) loadCampaign();
  }, [campaignId]);

  const loadCampaign = async () => {
    try {
      const data = await apiRequest<{
        campaign: CampaignDetail;
        metrics: Metrics;
        cost: { perMessage: number; total: number };
        recentMessages: MessageItem[];
      }>(`/campaigns/${campaignId}`);
      setCampaign(data.campaign);
      setMetrics(data.metrics);
      setCost(data.cost);
      setMessages(data.recentMessages);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <p className="text-gray-400 text-sm">Loading...</p>
          ) : !campaign ? (
            <p className="text-gray-500">Campaign not found</p>
          ) : (
            <div className="max-w-5xl">
              <div className="flex items-center gap-3 mb-6">
                <a href="/campaigns/" className="text-gray-400 hover:text-gray-600">
                  <ArrowLeft className="w-5 h-5" />
                </a>
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">{campaign.campaignName}</h2>
                  <p className="text-sm text-gray-500">
                    {campaign.businessName} • {campaign.templateName} •{" "}
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[campaign.status]}`}>
                      {campaign.status}
                    </span>
                  </p>
                </div>
              </div>

              {metrics && (
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
                  {(() => {
                    // Raw counts from API - backend counts each status exclusively
                    const total = metrics.total;
                    const failed = metrics.failed;
                    const queued = metrics.queued;
                    
                    // Cumulative: sent = everything not failed/queued
                    const sent = total - failed - queued;
                    // If backend already returns cumulative delivered (includes read), use as-is
                    // If backend returns exclusive counts, add them up
                    // Check: if delivered + read + failed + queued + sent_only > total, backend is cumulative
                    const delivered = metrics.delivered > metrics.read ? metrics.delivered : metrics.delivered + metrics.read;
                    const read = metrics.read;
                    const replied = metrics.replied;

                    // Ensure delivered doesn't exceed sent
                    const safeDelivered = Math.min(delivered, sent);

                    const items = [
                      { label: "Total", value: total, icon: Send, color: "text-gray-600", pct: null as number | null },
                      { label: "Sent", value: sent, icon: Send, color: "text-blue-600", pct: total ? Math.round((sent / total) * 100) : 0 },
                      { label: "Delivered", value: safeDelivered, icon: CheckCircle, color: "text-green-600", pct: sent ? Math.round((safeDelivered / sent) * 100) : 0 },
                      { label: "Read", value: read, icon: Eye, color: "text-purple-600", pct: safeDelivered ? Math.round((read / safeDelivered) * 100) : 0 },
                      { label: "Failed", value: failed, icon: XCircle, color: "text-red-600", pct: total ? Math.round((failed / total) * 100) : 0 },
                      { label: "Replied", value: replied, icon: MessageSquare, color: "text-indigo-600", pct: safeDelivered ? Math.round((replied / safeDelivered) * 100) : 0 },
                      { label: "Queued", value: queued, icon: Send, color: "text-gray-400", pct: null },
                    ];

                    return items.map((m) => (
                      <div key={m.label} className="bg-white rounded-lg border border-gray-200 p-3">
                        <m.icon className={`w-4 h-4 ${m.color} mb-1`} />
                        <p className="text-xl font-bold text-gray-900">{m.value}</p>
                        <p className="text-xs text-gray-500">{m.label}</p>
                        {m.pct !== null && m.value > 0 && (
                          <p className={`text-xs font-medium mt-0.5 ${m.color}`}>{m.pct}%</p>
                        )}
                      </div>
                    ));
                  })()}
                </div>
              )}

              <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
                <h3 className="font-semibold text-gray-900 mb-3">Campaign Info</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-gray-500">Schedule:</span> <span className="text-gray-900">{campaign.scheduleDate} {campaign.scheduleTime}</span></div>
                  <div><span className="text-gray-500">Contacts:</span> <span className="text-gray-900">{campaign.totalContacts}</span></div>
                  <div><span className="text-gray-500">Numbers:</span> <span className="text-gray-900">{campaign.selectedNumbers?.length || 0}</span></div>
                  <div><span className="text-gray-500">Created:</span> <span className="text-gray-900">{new Date(campaign.createdAt).toLocaleString()}</span></div>
                </div>
                {cost && (
                  <div className="mt-3 pt-3 border-t border-gray-200 flex items-center gap-4">
                    <div>
                      <p className="text-xs text-gray-500">Actual Cost (delivered)</p>
                      <p className="text-lg font-bold text-gray-900">₹{cost.total.toFixed(2)}</p>
                    </div>
                    <p className="text-xs text-gray-400">₹{cost.perMessage}/msg × {metrics?.delivered || 0} delivered</p>
                  </div>
                )}
              </div>

              {messages.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-200">
                    <h3 className="font-semibold text-gray-900">Messages (last 50)</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-gray-600">
                        <tr>
                          <th className="text-left px-5 py-2 font-medium">Phone</th>
                          <th className="text-left px-5 py-2 font-medium">Name</th>
                          <th className="text-left px-5 py-2 font-medium">Sent From</th>
                          <th className="text-left px-5 py-2 font-medium">Status</th>
                          <th className="text-left px-5 py-2 font-medium">Sent At</th>
                          <th className="text-left px-5 py-2 font-medium">Replied</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {messages.map((msg, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-5 py-2 text-gray-900">{msg.phone}</td>
                            <td className="px-5 py-2 text-gray-600">{msg.name || "-"}</td>
                            <td className="px-5 py-2 text-gray-500 text-xs">{msg.sendingNumber || "-"}</td>
                            <td className={`px-5 py-2 font-medium ${msgStatusColors[msg.status] || "text-gray-500"}`}>
                              {msg.status}{msg.errorCode ? ` — ${getErrorMessage(msg.errorCode)}` : ""}
                            </td>
                            <td className="px-5 py-2 text-gray-500">{msg.sentAt ? new Date(msg.sentAt).toLocaleTimeString() : "-"}</td>
                            <td className="px-5 py-2 text-gray-500">{msg.repliedAt ? "Yes" : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </AuthGuard>
  );
}
