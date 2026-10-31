"use client";

import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";

interface CostRow {
  workshop: string;
  batch: string;
  campaignCount: number;
  estimatedTotal: number;
  actualTotal: number;
  lastActivity: string;
}

// Last 12 calendar months, newest first, as a quick-pick shortcut for the
// date range — each option just fills in that month's first/last day.
function recentMonths(): { label: string; from: string; to: string }[] {
  const months = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth();
    const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const to = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    months.push({ label, from, to });
  }
  return months;
}

export default function TotalCostPage() {
  const [rows, setRows] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [workshopFilter, setWorkshopFilter] = useState("");
  const [batchFilter, setBatchFilter] = useState("");

  const months = useMemo(() => recentMonths(), []);

  const fetchRows = (from = dateFrom, to = dateTo) => {
    setFetching(true);
    setLoadError("");
    const params = new URLSearchParams();
    if (from) params.set("dateFrom", from);
    if (to) params.set("dateTo", to);
    const qs = params.toString();
    apiRequest<{ rows: CostRow[] }>(`/campaigns/total-cost${qs ? `?${qs}` : ""}`)
      .then((data) => setRows(data.rows))
      .catch((err) => {
        setRows([]);
        setLoadError(err instanceof Error ? err.message : "Failed to load cost data");
      })
      .finally(() => {
        setLoading(false);
        setFetching(false);
      });
  };

  // All-time on first load — no explicit range yet, so there's nothing to
  // wait on the user for. Changing the date fields afterward only updates
  // state; re-fetching then requires "Go" below (or a month quick-pick).
  useEffect(() => {
    fetchRows();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const handleDateFrom = (v: string) => { setSelectedMonth(""); setDateFrom(isIsoDate(v) || v === "" ? v : ""); };
  const handleDateTo = (v: string) => { setSelectedMonth(""); setDateTo(isIsoDate(v) || v === "" ? v : ""); };

  const handleMonthChange = (label: string) => {
    setSelectedMonth(label);
    if (!label) return;
    const m = months.find((mo) => mo.label === label);
    if (!m) return;
    setDateFrom(m.from);
    setDateTo(m.to);
    fetchRows(m.from, m.to);
  };

  // Workshop/batch are just row-level filters on already date-scoped totals —
  // no aggregation concern like the date range has, so these stay client-side.
  const workshops = Array.from(new Set(rows.map((r) => r.workshop))).sort();
  const batchesForWorkshop = Array.from(
    new Set(rows.filter((r) => !workshopFilter || r.workshop === workshopFilter).map((r) => r.batch).filter(Boolean))
  ).sort();

  const filteredRows = rows
    .filter((r) => !workshopFilter || r.workshop === workshopFilter)
    .filter((r) => !batchFilter || r.batch === batchFilter);

  const totalEstimated = filteredRows.reduce((sum, r) => sum + r.estimatedTotal, 0);
  const totalActual = filteredRows.reduce((sum, r) => sum + r.actualTotal, 0);

  return (
    <AuthGuard>
      <AppShell>
          <h2 className="text-2xl font-bold text-gray-900 mb-1">Total Cost</h2>
          <p className="text-sm text-gray-500 mb-6">
            Estimated and actual spend grouped by workshop &amp; batch, across every campaign ever sent for it.
          </p>

          <div className="flex flex-wrap items-end gap-3 mb-6">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Month</label>
              <select
                value={selectedMonth}
                onChange={(e) => handleMonthChange(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-40"
              >
                <option value="">Custom range</option>
                {months.map((m) => (
                  <option key={m.label} value={m.label}>{m.label}</option>
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
              onClick={() => fetchRows()}
              disabled={fetching}
              className="px-4 py-1.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
            >
              {fetching ? "Loading..." : "Go"}
            </button>
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(""); setDateTo(""); setSelectedMonth(""); fetchRows("", ""); }}
                className="text-xs text-gray-400 hover:text-gray-600 pb-2"
              >
                Reset to all-time
              </button>
            )}

            <div className="ml-auto flex items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Workshop</label>
                <select
                  value={workshopFilter}
                  onChange={(e) => { setWorkshopFilter(e.target.value); setBatchFilter(""); }}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-44"
                >
                  <option value="">All workshops</option>
                  {workshops.map((w) => (
                    <option key={w} value={w}>{w}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Batch</label>
                <select
                  value={batchFilter}
                  onChange={(e) => setBatchFilter(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-36"
                >
                  <option value="">All batches</option>
                  {batchesForWorkshop.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {loading ? (
            <p className="text-gray-400 text-sm">Loading...</p>
          ) : loadError ? (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{loadError}</div>
          ) : filteredRows.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-500">
              No campaign cost data for this filter.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 mb-6 max-w-lg">
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <p className="text-xs text-gray-500">Total Estimated</p>
                  <p className="text-2xl font-bold text-gray-900">₹{totalEstimated.toFixed(2)}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <p className="text-xs text-gray-500">Total Actual (delivered)</p>
                  <p className="text-2xl font-bold text-gray-900">₹{totalActual.toFixed(2)}</p>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="text-left px-6 py-3 font-medium">Workshop</th>
                        <th className="text-left px-6 py-3 font-medium">Batch</th>
                        <th className="text-left px-6 py-3 font-medium">Campaigns</th>
                        <th className="text-left px-6 py-3 font-medium">Estimated Cost</th>
                        <th className="text-left px-6 py-3 font-medium">Actual Cost</th>
                        <th className="text-left px-6 py-3 font-medium">Last Activity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filteredRows.map((r) => (
                        <tr key={`${r.workshop}-${r.batch}`} className="hover:bg-gray-50">
                          <td className="px-6 py-3 font-medium text-gray-900">{r.workshop}</td>
                          <td className="px-6 py-3 text-gray-600">{r.batch || "-"}</td>
                          <td className="px-6 py-3 text-gray-600">{r.campaignCount}</td>
                          <td className="px-6 py-3 text-gray-900">₹{r.estimatedTotal.toFixed(2)}</td>
                          <td className="px-6 py-3 text-gray-900 font-medium">₹{r.actualTotal.toFixed(2)}</td>
                          <td className="px-6 py-3 text-gray-500 text-xs">
                            {r.lastActivity ? new Date(r.lastActivity).toLocaleString() : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
      </AppShell>
    </AuthGuard>
  );
}
