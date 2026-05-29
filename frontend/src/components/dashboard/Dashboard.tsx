"use client";

import { DashboardStats, Campaign } from "@/types";
import StatsCards from "./StatsCards";
import RecentCampaigns from "./RecentCampaigns";

// Placeholder data — will be replaced with API calls
const mockStats: DashboardStats = {
  totalCampaigns: 24,
  scheduled: 3,
  running: 1,
  completed: 18,
  failed: 2,
};

const mockCampaigns: Campaign[] = [];

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
        <p className="text-gray-500 text-sm mt-1">Campaign overview and metrics</p>
      </div>
      <StatsCards stats={mockStats} />
      <RecentCampaigns campaigns={mockCampaigns} />
    </div>
  );
}
