"use client";

import { useEffect, useState } from "react";
import { DashboardStats, Campaign } from "@/types";
import { apiRequest } from "@/lib/api";
import StatsCards from "./StatsCards";
import RecentCampaigns from "./RecentCampaigns";
import { AlertTriangle, ExternalLink, X } from "lucide-react";

interface Notification {
  id: string;
  SK: string;
  type: string;
  businessName: string;
  phoneDisplayName: string;
  templateName: string;
  errorMessage: string;
  campaignId: string;
  appealLink: string;
  businessManagerLink: string;
  createdAt: string;
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    totalCampaigns: 0,
    scheduled: 0,
    running: 0,
    completed: 0,
    failed: 0,
  });
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    apiRequest<{ campaigns: Campaign[]; stats: DashboardStats }>("/campaigns")
      .then((data) => {
        setCampaigns(data.campaigns);
        setStats(data.stats);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    apiRequest<{ notifications: Notification[] }>("/notifications")
      .then((data) => setNotifications(data.notifications))
      .catch(() => {});
  }, []);

  const dismissNotification = async (sk: string) => {
    const notif = notifications.find((n) => n.SK === sk);
    if (!notif) return;
    try {
      await apiRequest(`/notifications?id=${notif.id}&sk=${encodeURIComponent(sk)}`, { method: "DELETE" });
      setNotifications((prev) => prev.filter((n) => n.SK !== sk));
    } catch {}
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
        <p className="text-gray-500 text-sm mt-1">Campaign overview and metrics</p>
      </div>

      {/* Notifications */}
      {notifications.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-red-700 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" />
            Action Required ({notifications.length})
          </h3>
          {notifications.map((n) => (
            <div key={n.SK} className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase ${n.type === "template_marketing" ? "bg-orange-100 text-orange-700" : "bg-red-100 text-red-700"}`}>
                    {n.type === "template_marketing" ? "MARKETING" : n.type === "send_failed" ? "FAILED" : n.type.replace("_", " ")}
                  </span>
                  <span className="text-xs text-gray-500">{new Date(n.createdAt).toLocaleString()}</span>
                </div>
                <p className="text-sm text-gray-900 font-medium">{n.errorMessage}</p>
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-600">
                  <span>📱 {n.phoneDisplayName}</span>
                  {n.templateName && <span>📄 {n.templateName}</span>}
                  {n.businessName && <span>🏢 {n.businessName}</span>}
                </div>
                <div className="flex items-center gap-3 mt-2">
                  {n.businessManagerLink && (
                    <a href={n.businessManagerLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium">
                      <ExternalLink className="w-3 h-3" /> Business Manager
                    </a>
                  )}
                  {n.appealLink && (
                    <a href={n.appealLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-700 font-medium">
                      <ExternalLink className="w-3 h-3" /> Appeal / Templates
                    </a>
                  )}
                </div>
              </div>
              <button onClick={() => dismissNotification(n.SK)} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-white text-gray-700 rounded-lg hover:bg-gray-100 border border-gray-200 shrink-0">
                <X className="w-3 h-3" /> Solved
              </button>
            </div>
          ))}
        </div>
      )}

      <StatsCards stats={stats} />
      {loading ? (
        <p className="text-gray-400 text-sm text-center py-8">Loading campaigns...</p>
      ) : (
        <RecentCampaigns campaigns={campaigns.slice(0, 10)} />
      )}
    </div>
  );
}
