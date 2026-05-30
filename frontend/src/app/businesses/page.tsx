"use client";

import { useState, useEffect } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { Business } from "@/types";
import { apiRequest } from "@/lib/api";
import { Phone } from "lucide-react";

export default function BusinessesPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadBusinesses();
  }, []);

  const loadBusinesses = async () => {
    try {
      const data = await apiRequest<{ businesses: Business[] }>("/businesses");
      setBusinesses(data.businesses);
    } catch {
      // API not connected yet
    } finally {
      setLoading(false);
    }
  };

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
            <p className="text-sm text-gray-400 mt-1">Businesses are added by the admin.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {businesses.map((biz) => (
              <div key={biz.businessId} className="bg-white rounded-xl border border-gray-200 p-5">
                <h3 className="font-semibold text-gray-900">{biz.businessName}</h3>
                <div className="mt-4 space-y-2">
                  {biz.phoneNumbers.map((pn) => (
                    <div key={pn.phoneNumberId} className="flex items-center gap-2 text-sm text-gray-600">
                      <Phone className="w-3.5 h-3.5 text-gray-400" />
                      <span>{pn.displayName}</span>
                      <span className="text-gray-400">•</span>
                      <span className="text-gray-400">{pn.displayNumber}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={async () => {
                    try {
                      const data = await apiRequest<{ results: { wabaid: string; status: string; error?: string }[] }>(
                        "/businesses/subscribe-webhooks",
                        { method: "POST", body: JSON.stringify({ businessId: biz.businessId }) }
                      );
                      const msg = data.results.map(r => `${r.wabaid}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n");
                      alert(msg);
                    } catch (err) {
                      alert("Failed to subscribe");
                    }
                  }}
                  className="mt-4 text-xs text-blue-600 hover:text-blue-700 font-medium"
                >
                  Subscribe WABAs to Webhooks
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
    </AuthGuard>
  );
}
