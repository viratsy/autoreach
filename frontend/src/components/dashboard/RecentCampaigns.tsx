"use client";

import { Send } from "lucide-react";
import { Campaign } from "@/types";

interface Props {
  campaigns: Campaign[];
}

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  scheduled: "bg-amber-100 text-amber-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

const iconColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-500",
  scheduled: "bg-amber-50 text-amber-600",
  running: "bg-blue-50 text-blue-600",
  completed: "bg-emerald-50 text-emerald-600",
  failed: "bg-red-50 text-red-600",
  cancelled: "bg-gray-100 text-gray-400",
};

export default function RecentCampaigns({ campaigns }: Props) {
  if (campaigns.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
        <p className="text-gray-500">No campaigns yet. Create your first campaign to get started.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <h3 className="font-semibold text-gray-900">Recent Campaigns</h3>
        <a href="/campaigns/" className="text-xs text-primary-600 hover:text-primary-700 font-medium">
          View all
        </a>
      </div>
      <div className="divide-y divide-gray-100">
        {campaigns.map((campaign) => {
          // Real delivery % from the counters list.ts now exposes — was
          // always "-" before since the list endpoint never returned them.
          // Scheduled/draft campaigns haven't sent anything yet, so a literal
          // 0 delivered there means "not started," not "0% delivery" — show
          // the schedule instead rather than a misleadingly bare "0.0%".
          const total = campaign.totalContacts || 0;
          const delivered = campaign.deliveredCount ?? 0;
          const hasStarted = campaign.status !== "scheduled" && campaign.status !== "draft";
          const deliveryRate = total > 0 && hasStarted && campaign.deliveredCount != null ? (delivered / total) * 100 : null;

          return (
            <a
              key={campaign.campaignId}
              href={`/campaigns/view/?id=${campaign.campaignId}`}
              className="flex items-center gap-3 px-6 py-3.5 hover:bg-gray-50 transition-colors"
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${iconColors[campaign.status] || iconColors.draft}`}>
                <Send className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{campaign.campaignName}</p>
                <p className="text-xs text-gray-400">
                  {campaign.businessName} · {total.toLocaleString()} recipient{total !== 1 ? "s" : ""}
                </p>
              </div>
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium shrink-0 ${statusColors[campaign.status] || statusColors.draft}`}>
                {campaign.status}
              </span>
              <div className="w-28 text-right shrink-0">
                {deliveryRate !== null ? (
                  <>
                    <p className="text-sm font-semibold text-gray-900">{deliveryRate.toFixed(1)}%</p>
                    <p className="text-xs text-gray-400">Delivery</p>
                  </>
                ) : campaign.status === "scheduled" ? (
                  <p className="text-xs text-gray-400">
                    {campaign.scheduleDate} {campaign.scheduleTime}
                  </p>
                ) : (
                  <p className="text-xs text-gray-300">-</p>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
