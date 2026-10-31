"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Business } from "@/types";
import { AlertTriangle } from "lucide-react";

interface NumberSpend {
  phoneNumberId: string;
  displayNumber: string;
  displayName: string;
  wabaid: string;
  cost: number;
  volume: number;
}

interface SpendResponse {
  businessId: string;
  businessName: string;
  currency: string;
  dateFrom: string;
  dateTo: string;
  totalCost: number;
  totalVolume: number;
  byNumber: NumberSpend[];
  unmatched: { phone: string; cost: number; volume: number }[];
  errors: { wabaid: string; message: string }[];
}

export default function WhatsAppSpendPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [data, setData] = useState<SpendResponse | null>(null);
  const [bizLoading, setBizLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses")
      .then((bizData) => {
        setBusinesses(bizData.businesses);
        // Spend tracking only works for Meta-connected businesses (pricing_analytics
        // is a Meta Cloud API field) — default to the first one that qualifies.
        const firstMeta = bizData.businesses.find((b) => (b.provider || "meta") === "meta");
        if (firstMeta) setBusinessId(firstMeta.businessId);
      })
      .catch(() => {})
      .finally(() => setBizLoading(false));
  }, []);

  // Takes explicit from/to rather than always reading state, so "Reset" can
  // clear the date fields and fetch in one click instead of needing a second
  // click after the cleared state has actually landed.
  const fetchSpend = (from = dateFrom, to = dateTo) => {
    if (!businessId) return;
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({ businessId });
    if (from) params.set("dateFrom", from);
    if (to) params.set("dateTo", to);
    apiRequest<SpendResponse>(`/businesses/whatsapp-spend?${params}`)
      .then(setData)
      .catch((err) => {
        setData(null);
        setLoadError(err instanceof Error ? err.message : "Failed to load spend data");
      })
      .finally(() => setLoading(false));
  };

  // Deliberately no auto-fetch on mount or business change — this calls Meta's
  // API live (slow, ~20s+ per WABA per earlier testing), so it should only run
  // when the user explicitly asks via "Go" below, never just from opening the
  // page or switching the business dropdown.

  const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const handleDateFrom = (v: string) => setDateFrom(isIsoDate(v) || v === "" ? v : "");
  const handleDateTo = (v: string) => setDateTo(isIsoDate(v) || v === "" ? v : "");

  const metaBusinesses = businesses.filter((b) => (b.provider || "meta") === "meta");

  return (
    <AuthGuard>
      <AppShell>
        <h2 className="text-2xl font-bold text-gray-900 mb-1">WhatsApp Spend</h2>
        <p className="text-sm text-gray-500 mb-6">
          Real spend Meta has billed per number — pulled live from Meta&apos;s pricing_analytics API, not
          estimated from our own per-message rates (that&apos;s what{" "}
          <a href="/costs/" className="text-primary-600 hover:underline">Total Cost</a> shows).
        </p>

        {bizLoading ? (
          <p className="text-gray-400 text-sm">Loading...</p>
        ) : metaBusinesses.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-500">
            No Meta-connected businesses found. WhatsApp spend is only available for businesses using Meta&apos;s
            WhatsApp Cloud API directly.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3 mb-6">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Business</label>
                <select
                  value={businessId}
                  onChange={(e) => setBusinessId(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-64"
                >
                  {metaBusinesses.map((b) => (
                    <option key={b.businessId} value={b.businessId}>{b.businessName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => handleDateFrom(e.target.value)}
                  onBlur={(e) => handleDateFrom(e.target.value)}
                  max={dateTo || undefined}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => handleDateTo(e.target.value)}
                  onBlur={(e) => handleDateTo(e.target.value)}
                  min={dateFrom || undefined}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-600"
                />
              </div>
              <button
                onClick={() => fetchSpend()}
                disabled={loading}
                className="px-4 py-1.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 mb-0"
              >
                {loading ? "Checking..." : "Go"}
              </button>
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => { setDateFrom(""); setDateTo(""); fetchSpend("", ""); }}
                  className="text-xs text-gray-400 hover:text-gray-600 pb-2"
                >
                  Reset to last 30 days
                </button>
              )}
            </div>

            {loading ? (
              <p className="text-gray-400 text-sm">Loading spend...</p>
            ) : loadError ? (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{loadError}</div>
            ) : data ? (
              <>
                {data.errors.length > 0 && (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                    <div className="flex items-center gap-2 font-medium mb-1">
                      <AlertTriangle className="w-4 h-4" />
                      Couldn&apos;t fetch spend for {data.errors.length} WhatsApp Business Account{data.errors.length !== 1 ? "s" : ""}
                    </div>
                    <ul className="list-disc list-inside text-xs space-y-0.5">
                      {data.errors.map((e, i) => (
                        <li key={i}>{e.wabaid}: {e.message}</li>
                      ))}
                    </ul>
                    <p className="text-xs mt-1">Totals below only reflect the accounts that loaded successfully.</p>
                  </div>
                )}

                <p className="text-xs text-gray-400 mb-3">{data.dateFrom} to {data.dateTo}</p>

                <div className="grid grid-cols-2 gap-4 mb-6 max-w-lg">
                  <div className="bg-white rounded-xl border border-gray-200 p-4">
                    <p className="text-xs text-gray-500">Total Spend (Meta-reported)</p>
                    <p className="text-2xl font-bold text-gray-900">₹{data.totalCost.toFixed(2)}</p>
                  </div>
                  <div className="bg-white rounded-xl border border-gray-200 p-4">
                    <p className="text-xs text-gray-500">Billable Messages</p>
                    <p className="text-2xl font-bold text-gray-900">{data.totalVolume.toLocaleString()}</p>
                  </div>
                </div>

                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-gray-600">
                        <tr>
                          <th className="text-left px-6 py-3 font-medium">Number</th>
                          <th className="text-left px-6 py-3 font-medium">Messages</th>
                          <th className="text-left px-6 py-3 font-medium">Spend</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {data.byNumber.map((n) => (
                          <tr key={n.phoneNumberId} className="hover:bg-gray-50">
                            <td className="px-6 py-3">
                              <p className="font-medium text-gray-900">{n.displayName}</p>
                              <p className="text-xs text-gray-400">{n.displayNumber}</p>
                            </td>
                            <td className="px-6 py-3 text-gray-600">{n.volume.toLocaleString()}</td>
                            <td className="px-6 py-3 text-gray-900 font-medium">₹{n.cost.toFixed(2)}</td>
                          </tr>
                        ))}
                        {data.unmatched.length > 0 && (
                          <tr className="bg-gray-50">
                            <td className="px-6 py-3">
                              <p className="font-medium text-gray-900">Other</p>
                              <p className="text-xs text-gray-400">
                                {data.unmatched.length} number{data.unmatched.length !== 1 ? "s" : ""} Meta reported that we couldn&apos;t match to a saved number
                              </p>
                            </td>
                            <td className="px-6 py-3 text-gray-600">
                              {data.unmatched.reduce((sum, u) => sum + u.volume, 0).toLocaleString()}
                            </td>
                            <td className="px-6 py-3 text-gray-900 font-medium">
                              ₹{data.unmatched.reduce((sum, u) => sum + u.cost, 0).toFixed(2)}
                            </td>
                          </tr>
                        )}
                        {data.byNumber.length === 0 && data.unmatched.length === 0 && (
                          <tr>
                            <td colSpan={3} className="px-6 py-8 text-center text-gray-400">
                              No billable messages in this range.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-500">
                Pick a date range (or leave it blank for the last 30 days) and click <strong>Go</strong> to fetch spend.
              </div>
            )}
          </>
        )}
      </AppShell>
    </AuthGuard>
  );
}
