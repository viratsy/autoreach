"use client";

import { useEffect, useState } from "react";
import { DashboardStats, Campaign } from "@/types";
import { apiRequest } from "@/lib/api";
import StatsCards from "./StatsCards";
import RecentCampaigns from "./RecentCampaigns";

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

  useEffect(() => {
    apiRequest<{ campaigns: Campaign[]; stats: DashboardStats }>("/campaigns")
      .then((data) => {
        setCampaigns(data.campaigns);
        setStats(data.stats);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
        <p className="text-gray-500 text-sm mt-1">Campaign overview and metrics</p>
      </div>
      <StatsCards stats={stats} />
      {loading ? (
        <p className="text-gray-400 text-sm text-center py-8">Loading campaigns...</p>
      ) : (
        <RecentCampaigns campaigns={campaigns.slice(0, 10)} />
      )}
    </div>
  );
}
