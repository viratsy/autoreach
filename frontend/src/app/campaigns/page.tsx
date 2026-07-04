"use client";

import { useState, useEffect } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { Campaign, CampaignStatus } from "@/types";
import { apiRequest } from "@/lib/api";
import { PlusCircle } from "lucide-react";

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  scheduled: "bg-yellow-100 text-yellow-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

const statusFilters: CampaignStatus[] = ["draft", "scheduled", "running", "completed", "failed", "cancelled"];

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [filter, setFilter] = useState<CampaignStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Record<string, { sent: number; delivered: number; read: number; failed: number; replies: number } | null>>({});
  const [checkingAll, setCheckingAll] = useState(false);

  useEffect(() => {
    loadCampaigns();
  }, []);

  const loadCampaigns = async () => {
    try {
      const data = await apiRequest<{ campaigns: Campaign[] }>("/campaigns");
      setCampaigns(data.campaigns);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const checkStats = async (campaignId: string) => {
    try {
      const data = await apiRequest<{ campaign: any; metrics?: any }>(`/campaigns/${campaignId}`);
      const m = data.metrics || data.campaign?.metrics || {};
      setStats((prev) => ({ ...prev, [campaignId]: { sent: m.sent || 0, delivered: m.delivered || 0, read: m.read || 0, failed: m.failed || 0, replies: m.replies || 0 } }));
    } catch {
      setStats((prev) => ({ ...prev, [campaignId]: null }));
    }
  };

  const checkAllStats = async () => {
    setCheckingAll(true);
    for (const c of filtered) {
      if (c.status !== "draft" && c.status !== "cancelled") {
        await checkStats(c.campaignId);
        await new Promise((r) => setTimeout(r, 200)); // Small delay to not overwhelm
      }
    }
    setCheckingAll(false);
  };

  const filtered = (filter === "all"
    ? campaigns
    : campaigns.filter((c) => c.status === filter)
  )
    .filter((c) => !search || c.campaignName.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      // Sort by schedule date descending (newest first)
      const dateA = `${a.scheduleDate} ${a.scheduleTime}`;
      const dateB = `${b.scheduleDate} ${b.scheduleTime}`;
      return dateB.localeCompare(dateA);
    });

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Campaigns</h2>
          <a
            href="/campaigns/new/"
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
          >
            <PlusCircle className="w-4 h-4" />
            New Campaign
          </a>
        </div>

        {/* Search + Filters */}
        <div className="flex items-center gap-3 mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns..."
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-64"
          />
          <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === "all" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All
          </button>
          {statusFilters.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
                filter === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {s}
            </button>
          ))}
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <p className="text-gray-500">No campaigns found.</p>
            <a href="/campaigns/new/" className="text-primary-600 text-sm mt-2 inline-block hover:underline">
              Create your first campaign
            </a>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-6 py-3 font-medium">Campaign</th>
                    <th className="text-left px-6 py-3 font-medium">Business</th>
                    <th className="text-left px-6 py-3 font-medium">Schedule</th>
                    <th className="text-left px-6 py-3 font-medium">Status</th>
                    <th className="text-left px-6 py-3 font-medium">Contacts</th>
                    <th className="text-left px-4 py-3 font-medium text-xs">Sent</th>
                    <th className="text-left px-4 py-3 font-medium text-xs">Delivered</th>
                    <th className="text-left px-4 py-3 font-medium text-xs">Read</th>
                    <th className="text-left px-4 py-3 font-medium text-xs">Replies</th>
                    <th className="text-left px-6 py-3 font-medium">
                      Actions
                      <button onClick={checkAllStats} disabled={checkingAll} className="ml-2 text-[10px] text-blue-600 hover:underline disabled:opacity-50">
                        {checkingAll ? "Checking..." : "Check All"}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((campaign) => (
                    <tr key={campaign.campaignId} className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-gray-900">{campaign.campaignName}</td>
                      <td className="px-6 py-3 text-gray-600">{campaign.businessName}</td>
                      <td className="px-6 py-3 text-gray-600">{campaign.scheduleDate} {campaign.scheduleTime}</td>
                      <td className="px-6 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[campaign.status]}`}>
                          {campaign.status}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-600">{campaign.totalContacts}</td>
                      <td className="px-4 py-3 text-xs text-gray-600">{stats[campaign.campaignId]?.sent ?? "-"}</td>
                      <td className="px-4 py-3 text-xs text-green-600">{stats[campaign.campaignId]?.delivered ?? "-"}</td>
                      <td className="px-4 py-3 text-xs text-blue-600">{stats[campaign.campaignId]?.read ?? "-"}</td>
                      <td className="px-4 py-3 text-xs text-purple-600">{stats[campaign.campaignId]?.replies ?? "-"}</td>
                      <td className="px-6 py-3">
                        <div className="flex gap-2 flex-wrap">
                          <button onClick={() => checkStats(campaign.campaignId)} className="text-blue-500 hover:text-blue-700 text-xs font-medium">Check</button>
                          <a href={`/campaigns/view/?id=${campaign.campaignId}`} className="text-primary-600 hover:text-primary-800 text-xs font-medium">
                            View
                          </a>
                          {campaign.status === "draft" && (
                            <a href={`/campaigns/new/?edit=${campaign.campaignId}`} className="text-blue-600 hover:text-blue-800 text-xs font-medium">
                              Edit
                            </a>
                          )}
                          {campaign.status === "scheduled" && (
                            <button
                              onClick={() => {
                                const date = prompt("New date (YYYY-MM-DD):", campaign.scheduleDate);
                                if (!date) return;
                                const time = prompt("New time (HH:MM, IST):", campaign.scheduleTime);
                                if (!time) return;
                                apiRequest(`/campaigns/${campaign.campaignId}/reschedule`, {
                                  method: "PUT",
                                  body: JSON.stringify({ scheduleDate: date, scheduleTime: time }),
                                }).then(() => { alert("Rescheduled!"); window.location.reload(); })
                                  .catch(() => alert("Failed to reschedule"));
                              }}
                              className="text-yellow-600 hover:text-yellow-800 text-xs font-medium"
                            >
                              Reschedule
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              try {
                                await apiRequest(`/campaigns/${campaign.campaignId}/duplicate`, { method: "POST" });
                                window.location.reload();
                              } catch {}
                            }}
                            className="text-gray-500 hover:text-gray-700 text-xs font-medium"
                          >
                            Duplicate
                          </button>
                          {campaign.status === "scheduled" && (
                            <button
                              onClick={async () => {
                                if (confirm("Cancel this campaign?")) {
                                  try {
                                    await apiRequest(`/campaigns/${campaign.campaignId}/cancel`, { method: "POST" });
                                    window.location.reload();
                                  } catch {}
                                }
                              }}
                              className="text-red-500 hover:text-red-700 text-xs font-medium"
                            >
                              Cancel
                            </button>
                          )}
                          {campaign.status === "running" && (
                            <button
                              onClick={async () => {
                                if (confirm("Stop this campaign and mark as completed?")) {
                                  try {
                                    await apiRequest(`/campaigns/${campaign.campaignId}/cancel`, { method: "POST" });
                                    window.location.reload();
                                  } catch {}
                                }
                              }}
                              className="text-red-500 hover:text-red-700 text-xs font-medium"
                            >
                              Stop
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
    </AuthGuard>
  );
}
