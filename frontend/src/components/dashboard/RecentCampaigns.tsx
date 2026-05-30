"use client";

import { Campaign } from "@/types";

interface Props {
  campaigns: Campaign[];
}

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  scheduled: "bg-yellow-100 text-yellow-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
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
      <div className="px-6 py-4 border-b border-gray-200">
        <h3 className="font-semibold text-gray-900">Recent Campaigns</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-6 py-3 font-medium">Campaign</th>
              <th className="text-left px-6 py-3 font-medium">Business</th>
              <th className="text-left px-6 py-3 font-medium">Schedule</th>
              <th className="text-left px-6 py-3 font-medium">Status</th>
              <th className="text-left px-6 py-3 font-medium">Contacts</th>
              <th className="text-left px-6 py-3 font-medium">Delivered</th>
              <th className="text-left px-6 py-3 font-medium">Read</th>
              <th className="text-left px-6 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {campaigns.map((campaign) => (
              <tr key={campaign.campaignId} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-medium text-gray-900">
                  {campaign.campaignName}
                </td>
                <td className="px-6 py-3 text-gray-600">{campaign.businessName}</td>
                <td className="px-6 py-3 text-gray-600">
                  {campaign.scheduleDate} {campaign.scheduleTime}
                </td>
                <td className="px-6 py-3">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[campaign.status]}`}>
                    {campaign.status}
                  </span>
                </td>
                <td className="px-6 py-3 text-gray-600">{campaign.totalContacts}</td>
                <td className="px-6 py-3 text-gray-600">{campaign.metrics?.delivered ?? "-"}</td>
                <td className="px-6 py-3 text-gray-600">{campaign.metrics?.read ?? "-"}</td>
                <td className="px-6 py-3">
                  <div className="flex gap-2">
                    <a href={`/campaigns/view/?id=${campaign.campaignId}`} className="text-primary-600 hover:text-primary-800 text-xs font-medium">
                      View
                    </a>
                    <a
                      href="#"
                      onClick={async (e) => {
                        e.preventDefault();
                        try {
                          const { apiRequest } = await import("@/lib/api");
                          await apiRequest(`/campaigns/${campaign.campaignId}/duplicate`, { method: "POST" });
                          window.location.reload();
                        } catch {}
                      }}
                      className="text-gray-500 hover:text-gray-700 text-xs font-medium"
                    >
                      Duplicate
                    </a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
