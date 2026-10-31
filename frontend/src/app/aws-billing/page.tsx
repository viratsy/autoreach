"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { RefreshCw, Info } from "lucide-react";

interface ServiceCost {
  service: string;
  total: number;
  autoreach: number;
  basis: "metered" | "modelled" | "none";
}

interface MonthlyCost {
  month: string;
  accountTotal: number;
  autoreachTotal: number;
  autoreachPercent: number;
  services: ServiceCost[];
  tax: number;
  taxAutoreach: number;
  final: boolean;
  computedAt: string;
  periodStart: string;
  periodEnd: string;
}

interface RunStatus {
  running?: boolean;
  startedAt?: string;
  finishedAt?: string;
  months?: string[];
  failed?: { month: string; message: string }[];
}

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

const shortDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });

const BASIS_NOTE: Record<ServiceCost["basis"], string> = {
  metered: "Split by the same units AWS bills on — this figure is measured, not estimated.",
  modelled: "Split by usage metrics that closely track billing (GB-seconds, request counts, log bytes).",
  none: "Nothing AutoReach deploys uses this service.",
};

export default function AwsBillingPage() {
  const [months, setMonths] = useState<MonthlyCost[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (keepSelection = true) => {
    const data = await apiRequest<{ months: MonthlyCost[]; status: RunStatus | null }>("/billing");
    setMonths(data.months);
    setStatus(data.status);
    setSelected((prev) => (keepSelection && prev ? prev : data.months[0]?.month || ""));
    return data;
  }, []);

  useEffect(() => {
    load(false)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load billing"))
      .finally(() => setLoading(false));
  }, [load]);

  // A recompute runs for minutes behind an async Lambda, so the only way to know
  // it finished is to keep asking. Polling stops as soon as the status row says
  // the run is done — and is torn down on unmount so it can't leak.
  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const data = await load();
        if (!data.status?.running) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setRefreshing(false);
        }
      } catch {
        /* transient — the next tick tries again */
      }
    }, 5000);
  }, [load]);

  useEffect(() => {
    // Resume polling if a scheduled run happens to be in flight on page load.
    if (status?.running && !pollRef.current) {
      setRefreshing(true);
      startPolling();
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status?.running, startPolling]);

  const refresh = async () => {
    setRefreshing(true);
    setLoadError("");
    try {
      await apiRequest("/billing/refresh", { method: "POST", body: JSON.stringify({}) });
      startPolling();
    } catch (err) {
      setRefreshing(false);
      setLoadError(err instanceof Error ? err.message : "Failed to start refresh");
    }
  };

  const current = months.find((m) => m.month === selected) || months[0];
  const previous = current ? months.find((m) => m.month < current.month) : undefined;

  // Only compare complete months against each other. A month-to-date figure is
  // always "down" on a full month, which reads as a saving that isn't real.
  const delta =
    current?.final && previous ? current.autoreachTotal - previous.autoreachTotal : null;

  // For a month still running, project instead: spend to date scaled to the
  // whole month, which is the number worth reacting to.
  const projection = (() => {
    if (!current || current.final) return null;
    const [y, mo] = current.month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const elapsed = Math.round(
      (Date.parse(current.periodEnd) - Date.parse(current.periodStart)) / 86400000
    );
    if (elapsed < 1) return null;
    return (current.autoreachTotal / elapsed) * daysInMonth;
  })();

  const maxTotal = current ? Math.max(...current.services.map((s) => s.total), 0.01) : 1;

  return (
    <AuthGuard>
      <AppShell>
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">AWS billing</h1>
            <p className="text-sm text-gray-600 mt-1 max-w-3xl">
              What this AWS account costs and how much of it is AutoReach. Figures come from Cost
              Explorer and are recomputed daily at 7:00 AM IST — AWS charges per query, so the page
              reads the cache rather than asking on every open.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="flex items-center gap-2 bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>

        {loadError && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
            {loadError}
          </div>
        )}

        {refreshing && (
          <div className="mb-4 bg-blue-50 border border-blue-200 text-blue-800 text-sm rounded-lg px-4 py-3">
            Recomputing from CloudWatch usage metrics — this takes a couple of minutes. The page
            updates itself when it finishes.
          </div>
        )}

        {loading ? (
          <p className="text-gray-500">Loading…</p>
        ) : !current ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
            <p className="text-gray-600">
              No billing data yet. Hit <span className="font-medium">Refresh now</span> to compute
              the current and previous month.
            </p>
          </div>
        ) : (
          <>
            {months.length > 1 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {months.map((m) => (
                  <button
                    key={m.month}
                    onClick={() => setSelected(m.month)}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                      m.month === current.month
                        ? "bg-primary-50 border-primary-200 text-primary-700 font-medium"
                        : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {monthLabel(m.month)}
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-white border border-gray-200 rounded-xl p-5">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  {monthLabel(current.month)} — whole account
                </p>
                <p className="text-3xl font-bold text-gray-900 mt-2">{usd(current.accountTotal)}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {current.final
                    ? "Final"
                    : `Month to date (through ${current.periodEnd})`}
                </p>
              </div>

              <div className="bg-white border-2 border-primary-200 rounded-xl p-5">
                <p className="text-xs uppercase tracking-wide text-primary-700">AutoReach share</p>
                <p className="text-3xl font-bold text-primary-700 mt-2">
                  {usd(current.autoreachTotal)}
                </p>
                <p className="text-xs text-gray-600 mt-1">
                  {current.autoreachPercent.toFixed(0)}% of the account
                  {delta !== null && (
                    <span className={delta >= 0 ? "text-red-600" : "text-green-600"}>
                      {" "}
                      · {delta >= 0 ? "▲" : "▼"} {usd(Math.abs(delta))} vs {monthLabel(previous!.month)}
                    </span>
                  )}
                  {projection !== null && (
                    <span className="text-gray-500"> · on track for ~{usd(projection)}</span>
                  )}
                </p>
              </div>

              <div className="bg-white border border-gray-200 rounded-xl p-5">
                <p className="text-xs uppercase tracking-wide text-gray-500">Last computed</p>
                <p className="text-xl font-bold text-gray-900 mt-2">
                  {shortDateTime(current.computedAt)}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {status?.failed?.length
                    ? `${status.failed.length} month(s) failed on the last run`
                    : "Recomputed daily at 7:00 AM IST"}
                </p>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6 flex gap-3">
              <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-900">
                The AutoReach share is measured from CloudWatch usage metrics, not from cost
                allocation tags — AWS does not apply tags retroactively, so tags cannot explain a
                past month. Because every DynamoDB table here is on-demand, the split tracks the
                bill exactly: for July 2026 the write units measured this way matched the billed
                quantity to the unit.
              </p>
            </div>

            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-6">
              <div className="px-5 py-3 border-b border-gray-200">
                <h2 className="font-semibold text-gray-900">
                  Services — {monthLabel(current.month)}
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="text-left font-medium px-5 py-2">Service</th>
                      <th className="text-right font-medium px-3 py-2">Account</th>
                      <th className="text-right font-medium px-3 py-2">AutoReach</th>
                      <th className="text-right font-medium px-5 py-2">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {current.services
                      .filter((s) => s.total >= 0.01)
                      .map((s) => {
                        const pct = s.total > 0 ? (s.autoreach / s.total) * 100 : 0;
                        return (
                          <tr key={s.service} className="hover:bg-gray-50">
                            <td className="px-5 py-2.5">
                              <div className="flex items-center gap-2">
                                <span className="text-gray-900">{s.service}</span>
                                <span
                                  title={BASIS_NOTE[s.basis]}
                                  className={`text-[10px] px-1.5 py-0.5 rounded-full cursor-help ${
                                    s.basis === "metered"
                                      ? "bg-green-50 text-green-700"
                                      : s.basis === "modelled"
                                        ? "bg-blue-50 text-blue-700"
                                        : "bg-gray-100 text-gray-500"
                                  }`}
                                >
                                  {s.basis}
                                </span>
                              </div>
                              <div className="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden max-w-xs">
                                <div
                                  className="h-full bg-gray-300"
                                  style={{ width: `${(s.total / maxTotal) * 100}%` }}
                                >
                                  <div
                                    className="h-full bg-primary-500"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                              {usd(s.total)}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums font-medium text-primary-700">
                              {s.autoreach >= 0.005 ? usd(s.autoreach) : "—"}
                            </td>
                            <td className="px-5 py-2.5 text-right tabular-nums text-gray-500">
                              {pct >= 0.5 ? `${pct.toFixed(0)}%` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    {current.tax >= 0.01 && (
                      <tr className="bg-gray-50">
                        <td className="px-5 py-2.5 text-gray-600 italic">
                          Tax (pro-rated across services)
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                          {usd(current.tax)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-medium text-primary-700">
                          {usd(current.taxAutoreach)}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-gray-500">
                          {((current.taxAutoreach / current.tax) * 100).toFixed(0)}%
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Month by month</h2>
            <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="text-left font-medium px-5 py-2">Month</th>
                    <th className="text-right font-medium px-3 py-2">Account total</th>
                    <th className="text-right font-medium px-3 py-2">AutoReach</th>
                    <th className="text-right font-medium px-3 py-2">Share</th>
                    <th className="text-left font-medium px-3 py-2">Top service</th>
                    <th className="text-left font-medium px-5 py-2">Computed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {months.map((m) => {
                    const top = m.services[0];
                    return (
                      <tr
                        key={m.month}
                        onClick={() => setSelected(m.month)}
                        className={`cursor-pointer hover:bg-gray-50 ${
                          m.month === current.month ? "bg-primary-50/40" : ""
                        }`}
                      >
                        <td className="px-5 py-2.5 font-medium text-gray-900">
                          {monthLabel(m.month)}
                          {!m.final && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                              in progress
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                          {usd(m.accountTotal)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-medium text-primary-700">
                          {usd(m.autoreachTotal)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">
                          {m.autoreachPercent.toFixed(0)}%
                        </td>
                        <td className="px-3 py-2.5 text-gray-600">
                          {top ? `${top.service} · ${usd(top.total)}` : "—"}
                        </td>
                        <td className="px-5 py-2.5 text-gray-400 text-xs">
                          {shortDateTime(m.computedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </AppShell>
    </AuthGuard>
  );
}
