"use client";

import { useState, useEffect } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { Business } from "@/types";
import { apiRequest } from "@/lib/api";
import { Phone, ExternalLink } from "lucide-react";

export default function BusinessesPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses")
      .then((data) => setBusinesses(data.businesses))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthGuard>
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">Businesses</h2>

        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : businesses.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <p className="text-gray-500">No businesses configured yet.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {businesses.map((biz) => (
              <div key={biz.businessId} className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-gray-900 text-lg">{biz.businessName}</h3>
                  <button
                    onClick={async () => {
                      try {
                        const data = await apiRequest<{ results: { wabaid: string; status: string; error?: string }[] }>(
                          "/businesses/subscribe-webhooks",
                          { method: "POST", body: JSON.stringify({ businessId: biz.businessId }) }
                        );
                        const msg = data.results.map(r => `${r.wabaid}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n");
                        alert(msg);
                      } catch {
                        alert("Failed");
                      }
                    }}
                    className="text-xs bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-100 font-medium"
                  >
                    Subscribe WABAs to Webhooks
                  </button>
                </div>

                {/* Numbers Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium">Name</th>
                        <th className="text-left px-4 py-2 font-medium">Number</th>
                        <th className="text-left px-4 py-2 font-medium">WABA ID</th>
                        <th className="text-left px-4 py-2 font-medium">Links</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {biz.phoneNumbers.map((pn) => (
                        <tr key={pn.phoneNumberId} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-900">{pn.displayName}</td>
                          <td className="px-4 py-3 text-gray-600">{pn.displayNumber}</td>
                          <td className="px-4 py-3 text-gray-400 text-xs font-mono">{pn.wabaid}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2">
                              <a
                                href={`https://business.facebook.com/business-support-home/${biz.metaBusinessId || biz.businessId}/${pn.wabaid}/?templates_tab=category_updates`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-xs text-orange-600 hover:text-orange-700"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Appeals
                              </a>
                              <a
                                href={`https://business.facebook.com/latest/whatsapp_manager/phone_numbers?business_id=${biz.metaBusinessId || biz.businessId}&asset_id=${pn.wabaid}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Manager
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
    </AuthGuard>
  );
}
