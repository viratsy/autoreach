"use client";

import { DashboardStats } from "@/types";
import { Send, Clock, Play, CheckCircle, XCircle } from "lucide-react";

interface Props {
  stats: DashboardStats;
}

const cards = [
  { key: "totalCampaigns", label: "Total Campaigns", icon: Send, color: "text-blue-600 bg-blue-50" },
  { key: "scheduled", label: "Scheduled", icon: Clock, color: "text-yellow-600 bg-yellow-50" },
  { key: "running", label: "Running", icon: Play, color: "text-green-600 bg-green-50" },
  { key: "completed", label: "Completed", icon: CheckCircle, color: "text-primary-600 bg-primary-50" },
  { key: "failed", label: "Failed", icon: XCircle, color: "text-red-600 bg-red-50" },
] as const;

export default function StatsCards({ stats }: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
      {cards.map((card) => (
        <div key={card.key} className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${card.color}`}>
              <card.icon className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">
                {stats[card.key]}
              </p>
              <p className="text-xs text-gray-500">{card.label}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
