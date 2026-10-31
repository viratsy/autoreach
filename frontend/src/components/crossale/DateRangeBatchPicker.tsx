"use client";

import { useState } from "react";
import { Search, Download } from "lucide-react";
import { apiRequest } from "@/lib/api";

interface Lead {
  phone: string;
  name: string;
  email: string;
  workshopName: string;
  batchDate: string;
}

function toCsvField(value: string): string {
  const str = value ?? "";
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export interface BatchGroup {
  wsCode: string;
  workshopName: string;
  firstBatchDate: string;
  total: number;
}

interface WorkshopSummary {
  wsCode: string;
  workshopName: string;
  batchCount: number;
  totalRegistered: number;
}

interface Props {
  onNext: (selected: BatchGroup[]) => void;
}

const groupKey = (g: BatchGroup) => `${g.wsCode}#${g.firstBatchDate}`;

export default function DateRangeBatchPicker({ onNext }: Props) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [groups, setGroups] = useState<BatchGroup[]>([]);
  const [selectedWorkshops, setSelectedWorkshops] = useState<Set<string>>(new Set());
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const [excludePaid, setExcludePaid] = useState(false);

  const search = async () => {
    if (!startDate || !endDate) return;
    setLoading(true);
    setSearched(true);
    try {
      const data = await apiRequest<{ groups: BatchGroup[] }>(
        `/crossale/batches?startDate=${startDate}&endDate=${endDate}`
      );
      setGroups(data.groups);
      setSelectedWorkshops(new Set());
      setSelectedDates(new Set());
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  };

  const workshops: WorkshopSummary[] = Object.values(
    groups.reduce((acc, g) => {
      if (!acc[g.wsCode]) acc[g.wsCode] = { wsCode: g.wsCode, workshopName: g.workshopName, batchCount: 0, totalRegistered: 0 };
      acc[g.wsCode].batchCount++;
      acc[g.wsCode].totalRegistered += g.total;
      return acc;
    }, {} as Record<string, WorkshopSummary>)
  );

  const toggleWorkshop = (wsCode: string) => {
    const ws = new Set(selectedWorkshops);
    const ds = new Set(selectedDates);
    if (ws.has(wsCode)) {
      ws.delete(wsCode);
      // Dropping the workshop also drops any batch dates already picked for it.
      groups.filter((g) => g.wsCode === wsCode).forEach((g) => ds.delete(groupKey(g)));
    } else {
      ws.add(wsCode);
    }
    setSelectedWorkshops(ws);
    setSelectedDates(ds);
  };

  const datesInScope = groups.filter((g) => selectedWorkshops.has(g.wsCode));
  const allDatesSelected = datesInScope.length > 0 && datesInScope.every((g) => selectedDates.has(groupKey(g)));

  const toggleDate = (g: BatchGroup) => {
    const s = new Set(selectedDates);
    const k = groupKey(g);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    setSelectedDates(s);
  };

  const toggleSelectAllDates = () => {
    if (allDatesSelected) {
      setSelectedDates(new Set());
    } else {
      setSelectedDates(new Set(datesInScope.map(groupKey)));
    }
  };

  const selectedGroups = groups.filter((g) => selectedDates.has(groupKey(g)));
  const selectedRegisteredTotal = selectedGroups.reduce((sum, g) => sum + g.total, 0);

  const handleDownloadCsv = async () => {
    if (selectedGroups.length === 0 || downloadingCsv) return;
    setDownloadingCsv(true);
    try {
      const data = await apiRequest<{ leads: Lead[] }>("/crossale/leads", {
        method: "POST",
        body: JSON.stringify({
          groups: selectedGroups.map((g) => ({ wsCode: g.wsCode, workshopName: g.workshopName, batchDate: g.firstBatchDate })),
          excludePaid,
        }),
      });

      const headers = ["Name", "Phone", "Email", "Workshop", "Batch Date"];
      const rows = data.leads.map((l) => [l.name, l.phone, l.email, l.workshopName, l.batchDate]);
      const csv = [headers, ...rows].map((r) => r.map(toCsvField).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `crossale_${startDate}_to_${endDate}${excludePaid ? "_unpaid" : ""}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // best-effort — no result banner needed, button just stops spinning
    } finally {
      setDownloadingCsv(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">Pick a Date Range</h3>
      <p className="text-sm text-gray-500 mb-4">
        Finds past workshop batches whose workshop date falls in this window.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Start date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">End date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={search}
          disabled={!startDate || !endDate || loading}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-primary-700"
        >
          <Search className="w-4 h-4" /> {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {searched && !loading && groups.length === 0 && (
        <p className="text-sm text-gray-400 py-6 text-center">No batches found in this range.</p>
      )}

      {workshops.length > 0 && (
        <div className="mb-5">
          <p className="text-xs font-medium text-gray-600 mb-2">1. Select workshop(s)</p>
          <div className="space-y-2 max-h-64 overflow-y-auto border border-gray-100 rounded-lg p-3">
            {workshops.map((ws) => (
              <label
                key={ws.wsCode}
                className={`flex items-center justify-between gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedWorkshops.has(ws.wsCode) ? "border-primary-500 bg-primary-50" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedWorkshops.has(ws.wsCode)}
                    onChange={() => toggleWorkshop(ws.wsCode)}
                    className="w-4 h-4 text-primary-600 rounded"
                  />
                  <p className="text-sm font-medium text-gray-900">{ws.workshopName}</p>
                </div>
                <div className="text-xs text-gray-500 text-right shrink-0">
                  <p>
                    <span className="font-medium text-gray-900">{ws.batchCount}</span> batch{ws.batchCount !== 1 ? "es" : ""}
                  </p>
                  <p className="text-gray-400">{ws.totalRegistered} registered</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {datesInScope.length > 0 && (
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-gray-600">
              2. Select batch date(s)
              {selectedGroups.length > 0 && (
                <span className="ml-2 font-normal text-gray-400">
                  {selectedGroups.length} selected · {selectedRegisteredTotal} registered
                </span>
              )}
            </p>
            <button onClick={toggleSelectAllDates} className="text-xs font-medium text-primary-600 hover:text-primary-700">
              {allDatesSelected ? "Deselect All" : "Select All"}
            </button>
          </div>
          <div className="space-y-2 max-h-96 overflow-y-auto border border-gray-100 rounded-lg p-3">
            {datesInScope.map((g) => (
              <label
                key={groupKey(g)}
                className={`flex items-center justify-between gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedDates.has(groupKey(g)) ? "border-primary-500 bg-primary-50" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedDates.has(groupKey(g))}
                    onChange={() => toggleDate(g)}
                    className="w-4 h-4 text-primary-600 rounded"
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-900">{g.workshopName}</p>
                    <p className="text-xs text-gray-500">Batch: {g.firstBatchDate || "unknown"}</p>
                  </div>
                </div>
                <div className="text-xs text-gray-500 text-right shrink-0">
                  <p>
                    <span className="font-medium text-gray-900">{g.total}</span> registered
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={excludePaid}
            onChange={(e) => setExcludePaid(e.target.checked)}
            className="w-3.5 h-3.5 text-primary-600 rounded"
          />
          Exclude paid contacts from CSV
        </label>
        <div className="flex gap-2">
          <button
            onClick={handleDownloadCsv}
            disabled={selectedGroups.length === 0 || downloadingCsv}
            className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 transition-colors"
          >
            <Download className={`w-4 h-4 ${downloadingCsv ? "animate-pulse" : ""}`} />
            {downloadingCsv ? "Preparing..." : "Download CSV"}
          </button>
          <button
            onClick={() => onNext(selectedGroups)}
            disabled={selectedGroups.length === 0}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
          >
            Next ({selectedGroups.length} batch{selectedGroups.length !== 1 ? "es" : ""}
            {selectedGroups.length > 0 ? ` · ${selectedRegisteredTotal} registered` : ""})
          </button>
        </div>
      </div>
    </div>
  );
}
