"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { ArrowLeft, Send, CheckCircle, Eye, XCircle, MessageSquare, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";

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
  skipped: number;
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
  "131042": "Payment issue",
  "131047": "24hr window expired",
  "131026": "Not on WhatsApp",
  "131051": "Unsupported message type",
  "132000": "Parameter count mismatch",
  "132001": "Template does not exist",
  "132005": "Template hydration failed",
  "132012": "Parameter format mismatch",
  "132015": "Template paused",
  "132016": "Template disabled",
  "133010": "Number not registered",
  "130429": "Rate limit hit",
  "131056": "Pair rate limit hit",
  "368": "Blocked for policy violations",
  "unsubscribed": "Unsubscribed",
};

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
  skipped: "text-orange-500",
  replied: "text-indigo-600",
};

type StatusFilter = "sent" | "delivered" | "read" | "failed" | "skipped" | "replied" | null;

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
  const [cost, setCost] = useState<{ perMessage: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);

  // Message list state
  const [activeFilter, setActiveFilter] = useState<StatusFilter>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalMsgs, setTotalMsgs] = useState(0);

  // Action state
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<{ retried: number; skipped: number; message: string } | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeResult, setResumeResult] = useState<{ resumed: number; message: string } | null>(null);

  useEffect(() => { if (campaignId) loadCampaign(); }, [campaignId]);

  useEffect(() => {
    if (activeFilter && campaignId) loadMessages(activeFilter, 1);
  }, [activeFilter]);

  const loadCampaign = async () => {
    try {
      const data = await apiRequest<{ campaign: CampaignDetail; metrics: Metrics; cost: { perMessage: number; total: number } }>(
        `/campaigns/${campaignId}`
      );
      setCampaign(data.campaign);
      setMetrics(data.metrics);
      setCost(data.cost);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (status: StatusFilter, p: number) => {
    if (!status) return;
    setMsgLoading(true);
    try {
      const data = await apiRequest<{ messages: MessageItem[]; total: number; page: number; totalPages: number }>(
        `/campaigns/${campaignId}?status=${status}&page=${p}&limit=50`
      );
      setMessages(data.messages);
      setPage(data.page);
      setTotalPages(data.totalPages);
      setTotalMsgs(data.total);
    } catch {
      setMessages([]);
    } finally {
      setMsgLoading(false);
    }
  };

  const handleFilterClick = (status: StatusFilter) => {
    if (activeFilter === status) {
      setActiveFilter(null);
      setMessages([]);
    } else {
      setActiveFilter(status);
      setPage(1);
    }
  };

  const handleRetry = async () => {
    if (!campaignId || retrying) return;
    setRetrying(true);
    setRetryResult(null);
    try {
      const data = await apiRequest<{ retried: number; skipped: number; message: string }>(
        `/campaigns/${campaignId}/retry`, { method: "POST" }
      );
      setRetryResult(data);
      setTimeout(() => loadCampaign(), 2000);
    } catch {
      setRetryResult({ retried: 0, skipped: 0, message: "Retry failed. Please try again." });
    } finally {
      setRetrying(false);
    }
  };

  const handleResume = async () => {
    if (!campaignId || resuming) return;
    setResuming(true);
    setResumeResult(null);
    try {
      const data = await apiRequest<{ resumed: number; message: string }>(
        `/campaigns/${campaignId}/resume`, { method: "POST" }
      );
      setResumeResult(data);
      setTimeout(() => loadCampaign(), 3000);
    } catch {
      setResumeResult({ resumed: 0, message: "Resume failed. Please try again." });
    } finally {
      setResuming(false);
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

              {/* Header */}
              <div className="flex items-center gap-3 mb-6">
                <a href="/campaigns/" className="text-gray-400 hover:text-gray-600">
                  <ArrowLeft className="w-5 h-5" />
                </a>
                <div className="flex-1">
                  <h2 className="text-2xl font-bold text-gray-900">{campaign.campaignName}</h2>
                  <p className="text-sm text-gray-500">
                    {campaign.businessName} • {campaign.templateName} •{" "}
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[campaign.status]}`}>
                      {campaign.status}
                    </span>
                  </p>
                </div>
                {metrics && metrics.failed > 0 && (
                  <button onClick={handleRetry} disabled={retrying}
                    className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white text-sm font-medium rounded-lg transition-colors">
                    <RefreshCw className={`w-4 h-4 ${retrying ? "animate-spin" : ""}`} />
                    {retrying ? "Retrying..." : `Retry Failed (${metrics.failed})`}
                  </button>
                )}
                {campaign.status === "running" && (
                  <button onClick={handleResume} disabled={resuming}
                    className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white text-sm font-medium rounded-lg transition-colors">
                    <RefreshCw className={`w-4 h-4 ${resuming ? "animate-spin" : ""}`} />
                    {resuming ? "Resuming..." : "Resume Stuck"}
                  </button>
                )}
              </div>

              {/* Banners */}
              {retryResult && (
                <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${retryResult.retried > 0 ? "bg-green-50 border border-green-200 text-green-800" : "bg-yellow-50 border border-yellow-200 text-yellow-800"}`}>
                  {retryResult.message}
                  {retryResult.retried > 0 && <span className="ml-2 font-medium">Queued {retryResult.retried} for retry.</span>}
                  {retryResult.skipped > 0 && <span className="ml-2 text-gray-500">{retryResult.skipped} non-retryable skipped.</span>}
                </div>
              )}
              {resumeResult && (
                <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${resumeResult.resumed > 0 ? "bg-orange-50 border border-orange-200 text-orange-800" : "bg-green-50 border border-green-200 text-green-800"}`}>
                  {resumeResult.message}
                  {resumeResult.resumed > 0 && <span className="ml-2 font-medium">Re-queued {resumeResult.resumed} stuck contacts.</span>}
                </div>
              )}

              {/* Metric Cards — click to filter messages below */}
              {metrics && (() => {
                const skipped = metrics.skipped || 0;
                const items: { label: string; value: number; icon: React.ElementType; color: string; activeColor: string; pct: number | null; filter: StatusFilter }[] = [
                  { label: "Total",     value: metrics.total,     icon: Send,          color: "text-gray-600",   activeColor: "border-gray-400 bg-gray-50",    pct: null,                                                                                       filter: null },
                  { label: "Sent",      value: metrics.sent,      icon: Send,          color: "text-blue-600",   activeColor: "border-blue-400 bg-blue-50",    pct: metrics.total     ? Math.round((metrics.sent      / metrics.total)     * 100) : 0, filter: "sent" },
                  { label: "Delivered", value: metrics.delivered, icon: CheckCircle,   color: "text-green-600",  activeColor: "border-green-400 bg-green-50",  pct: metrics.sent      ? Math.round((metrics.delivered / metrics.sent)      * 100) : 0, filter: "delivered" },
                  { label: "Read",      value: metrics.read,      icon: Eye,           color: "text-purple-600", activeColor: "border-purple-400 bg-purple-50",pct: metrics.delivered ? Math.round((metrics.read      / metrics.delivered) * 100) : 0, filter: "read" },
                  { label: "Failed",    value: metrics.failed,    icon: XCircle,       color: "text-red-600",    activeColor: "border-red-400 bg-red-50",      pct: metrics.total     ? Math.round((metrics.failed    / metrics.total)     * 100) : 0, filter: "failed" },
                  { label: "Skipped",   value: skipped,           icon: XCircle,       color: "text-orange-500", activeColor: "border-orange-400 bg-orange-50",pct: null,                                                                                       filter: "skipped" },
                  { label: "Replied",   value: metrics.replied,   icon: MessageSquare, color: "text-indigo-600", activeColor: "border-indigo-400 bg-indigo-50",pct: metrics.delivered ? Math.round((metrics.replied   / metrics.delivered) * 100) : 0, filter: "replied" },
                ];
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
                    {items.map((m) => (
                      <button
                        key={m.label}
                        onClick={() => m.filter && handleFilterClick(m.filter)}
                        className={`bg-white rounded-lg border-2 p-3 text-left transition-all ${
                          m.filter
                            ? activeFilter === m.filter
                              ? `${m.activeColor} cursor-pointer`
                              : "border-gray-200 hover:border-gray-300 cursor-pointer"
                            : "border-gray-200 cursor-default"
                        }`}
                      >
                        <m.icon className={`w-4 h-4 ${m.color} mb-1`} />
                        <p className="text-xl font-bold text-gray-900">{m.value}</p>
                        <p className="text-xs text-gray-500">{m.label}</p>
                        {m.pct !== null && m.value > 0 && (
                          <p className={`text-xs font-medium mt-0.5 ${m.color}`}>{m.pct}%</p>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })()}

              {/* Campaign Info */}
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

              {/* Message List — shown when a filter card is clicked */}
              {activeFilter && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900 capitalize">
                      {activeFilter} messages
                      {totalMsgs > 0 && <span className="ml-2 text-sm text-gray-400 font-normal">({totalMsgs} total)</span>}
                    </h3>
                    <button onClick={() => { setActiveFilter(null); setMessages([]); }} className="text-xs text-gray-400 hover:text-gray-600">✕ Close</button>
                  </div>

                  {msgLoading ? (
                    <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
                  ) : messages.length === 0 ? (
                    <div className="p-8 text-center text-gray-400 text-sm">No {activeFilter} messages found</div>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 text-gray-600">
                            <tr>
                              <th className="text-left px-5 py-2 font-medium">Phone</th>
                              <th className="text-left px-5 py-2 font-medium">Name</th>
                              <th className="text-left px-5 py-2 font-medium">Sent From</th>
                              <th className="text-left px-5 py-2 font-medium">Status</th>
                              <th className="text-left px-5 py-2 font-medium">Sent At</th>
                              {activeFilter === "failed" && <th className="text-left px-5 py-2 font-medium">Error</th>}
                              {activeFilter === "replied" && <th className="text-left px-5 py-2 font-medium">Replied At</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {messages.map((msg, i) => (
                              <tr key={i} className="hover:bg-gray-50">
                                <td className="px-5 py-2 text-gray-900">{msg.phone}</td>
                                <td className="px-5 py-2 text-gray-600">{msg.name || "-"}</td>
                                <td className="px-5 py-2 text-gray-500 text-xs">{msg.sendingNumber || "-"}</td>
                                <td className={`px-5 py-2 font-medium ${msgStatusColors[msg.status] || "text-gray-500"}`}>{msg.status}</td>
                                <td className="px-5 py-2 text-gray-500">{msg.sentAt ? new Date(msg.sentAt).toLocaleTimeString() : "-"}</td>
                                {activeFilter === "failed" && (
                                  <td className="px-5 py-2 text-red-500 text-xs">{msg.errorCode ? (ERROR_MESSAGES[msg.errorCode] || msg.errorCode) : "-"}</td>
                                )}
                                {activeFilter === "replied" && (
                                  <td className="px-5 py-2 text-gray-500">{msg.repliedAt ? new Date(msg.repliedAt).toLocaleTimeString() : "-"}</td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
                          <p className="text-xs text-gray-500">Page {page} of {totalPages}</p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => { const p = page - 1; setPage(p); loadMessages(activeFilter, p); }}
                              disabled={page === 1}
                              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => { const p = page + 1; setPage(p); loadMessages(activeFilter, p); }}
                              disabled={page === totalPages}
                              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

            </div>
          )}
        </main>
      </div>
    </AuthGuard>
  );
}
