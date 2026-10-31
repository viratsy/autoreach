"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { Campaign, CampaignStatus } from "@/types";
import { apiRequest } from "@/lib/api";
import { PlusCircle, ArrowUp, ArrowDown, ArrowUpDown, Calculator, X, ChevronLeft, ChevronRight, MessageCircle, Mail } from "lucide-react";
import ConfirmDialog, { ConfirmDialogState } from "@/components/shared/ConfirmDialog";
import ResultDialog, { ResultDialogState } from "@/components/shared/ResultDialog";
import RescheduleDialog from "@/components/shared/RescheduleDialog";
import RowActionsMenu from "@/components/shared/RowActionsMenu";

/** Exactly what GET /campaigns/{id} returns as `metrics` (see backend get.ts).
 *  Note `replied`, not `replies` — reading the wrong name here is what pinned
 *  the campaigns list's Replies column at 0. */
interface CampaignMetrics {
  total: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  queued: number;
  replied: number;
  emailEnabled?: boolean;
  emailSent?: number;
  emailDelivered?: number;
  emailClicked?: number;
  emailOpened?: number;
}

type SortKey = "campaignName" | "businessName" | "created" | "schedule" | "status" | "totalContacts" | "sent" | "delivered" | "read" | "replies";

const PAGE_SIZE = 20;

// Mirrors backend/src/lib/capacity.ts's safe per-number pace, same as the
// campaign detail page and ReviewSchedule.
const SAFE_MSGS_PER_SECOND = 5;

function formatSendDuration(seconds: number): string {
  if (seconds < 60) return "<1m";
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  scheduled: "bg-yellow-100 text-yellow-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

const statusFilters: CampaignStatus[] = ["draft", "scheduled", "running", "completed", "failed", "cancelled"];

function formatTime12h(time: string): string {
  const [hStr, m] = time.split(":");
  const h = parseInt(hStr, 10);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${period}`;
}

export default function CampaignsPage() {
  const router = useRouter();
  // Holds only the CURRENT PAGE's campaigns — filtering, sorting, and
  // pagination all happen server-side now (list.ts) so the client never has
  // to hold or scan every campaign in the account just to show 20 of them.
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<CampaignStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [stats, setStats] = useState<Record<string, { sent: number; delivered: number; read: number; failed: number; replies: number; emailEnabled: boolean; emailSent: number; emailDelivered: number; emailOpened: number; emailClicked: number } | null>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Defaults match the table's previous fixed behavior (newest-scheduled first).
  const [sortKey, setSortKey] = useState<SortKey>("schedule");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Keyed by campaignId but stores the full Campaign — selections made on one
  // page need to survive navigating to another page for the cost total below
  // to stay correct (a plain Set of ids would lose the cost/contacts data).
  const [selectedMap, setSelectedMap] = useState<Map<string, Campaign>>(new Map());
  const [selectingAll, setSelectingAll] = useState(false);
  const [approving, setApproving] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [resultState, setResultState] = useState<ResultDialogState | null>(null);
  const [reschedulingCampaign, setReschedulingCampaign] = useState<Campaign | null>(null);
  const [reschedulingLoading, setReschedulingLoading] = useState(false);

  const runConfirmed = async () => {
    if (!confirmState) return;
    setConfirmLoading(true);
    try {
      await confirmState.onConfirm();
    } finally {
      setConfirmLoading(false);
      setConfirmState(null);
    }
  };

  // Debounce free-text search so every keystroke doesn't trigger a fetch.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    loadCampaigns();
  }, [page, filter, debouncedSearch, dateFrom, dateTo, sortKey, sortDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared by the normal page fetch and "select all matching filter" below —
  // both need the exact same status/search/date/sort params, just a different
  // page/limit.
  const buildParams = (pageNum: number, limit: number) => {
    const params = new URLSearchParams({ page: String(pageNum), limit: String(limit), sortKey, sortDir });
    if (filter !== "all") params.set("status", filter);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    return params;
  };

  const loadCampaigns = async () => {
    setPageLoading(true);
    try {
      const data = await apiRequest<{ campaigns: Campaign[]; totalCount: number; totalPages: number }>(
        `/campaigns?${buildParams(page, PAGE_SIZE)}`
      );
      setCampaigns(data.campaigns);
      setTotalCount(data.totalCount);
      setTotalPages(data.totalPages);
    } catch {
    } finally {
      setLoading(false);
      setPageLoading(false);
    }
  };

  // Fetches every campaign matching the current filter — not just the visible
  // page — and adds them all to the selection, so "select all" can drive the
  // cost calculator over an entire date range without keeping every campaign
  // loaded in the table all the time (that's exactly what pagination avoids).
  const BULK_SELECT_LIMIT = 500;
  const BULK_SELECT_SAFETY_CAP = 5000;
  const selectAllMatchingFilter = async () => {
    setSelectingAll(true);
    try {
      const fetched: Campaign[] = [];
      let bulkPage = 1;
      let bulkTotalPages = 1;
      do {
        const data = await apiRequest<{ campaigns: Campaign[]; totalPages: number }>(
          `/campaigns?${buildParams(bulkPage, BULK_SELECT_LIMIT)}`
        );
        fetched.push(...data.campaigns);
        bulkTotalPages = data.totalPages;
        bulkPage += 1;
      } while (bulkPage <= bulkTotalPages && fetched.length < BULK_SELECT_SAFETY_CAP);

      setSelectedMap((prev) => {
        const next = new Map(prev);
        fetched.forEach((c) => next.set(c.campaignId, c));
        return next;
      });
    } catch {
      setResultState({ title: "Selection failed", summary: "Failed to select all matching campaigns" });
    } finally {
      setSelectingAll(false);
    }
  };

  const checkStats = async (campaignId: string) => {
    try {
      const data = await apiRequest<{ campaign?: { metrics?: CampaignMetrics }; metrics?: CampaignMetrics }>(
        `/campaigns/${campaignId}`
      );
      const m: Partial<CampaignMetrics> = data.metrics || data.campaign?.metrics || {};
      // The API calls this one `replied`, not `replies` — reading the wrong key
      // silently pinned this column at 0 for every campaign, even ones with
      // hundreds of replies (the detail page, which reads `metrics.replied`,
      // showed them correctly all along).
      setStats((prev) => ({ ...prev, [campaignId]: { sent: m.sent || 0, delivered: m.delivered || 0, read: m.read || 0, failed: m.failed || 0, replies: m.replied || 0, emailEnabled: m.emailEnabled === true, emailSent: m.emailSent || 0, emailDelivered: m.emailDelivered || 0, emailOpened: m.emailOpened || 0, emailClicked: m.emailClicked || 0 } }));
    } catch {
      setStats((prev) => ({ ...prev, [campaignId]: null }));
    }
  };

  const checkAllStats = async () => {
    setCheckingAll(true);
    for (const c of campaigns) {
      if (c.status !== "draft" && c.status !== "cancelled") {
        await checkStats(c.campaignId);
        await new Promise((r) => setTimeout(r, 200)); // Small delay to not overwhelm
      }
    }
    setCheckingAll(false);
  };

  // Native <input type="date"> only ever calls onChange with a full "YYYY-MM-DD"
  // value or "" — but guard against a malformed value slipping through anyway
  // (some browser/OS combinations are inconsistent here) rather than silently
  // sending garbage to the server and making the filter a no-op.
  const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const handleDateFrom = (v: string) => { setDateFrom(isIsoDate(v) || v === "" ? v : ""); setPage(1); };
  const handleDateTo = (v: string) => { setDateTo(isIsoDate(v) || v === "" ? v : ""); setPage(1); };

  const setFilterAndReset = (f: CampaignStatus | "all") => { setFilter(f); setPage(1); };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(1);
  };

  const toggleSelect = (campaign: Campaign) => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (next.has(campaign.campaignId)) next.delete(campaign.campaignId);
      else next.set(campaign.campaignId, campaign);
      return next;
    });
  };

  const allPageSelected = campaigns.length > 0 && campaigns.every((c) => selectedMap.has(c.campaignId));
  const toggleSelectAllOnPage = () => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (allPageSelected) {
        campaigns.forEach((c) => next.delete(c.campaignId));
      } else {
        campaigns.forEach((c) => next.set(c.campaignId, c));
      }
      return next;
    });
  };

  const selectedCampaigns = Array.from(selectedMap.values());
  const selectedTotals = selectedCampaigns.reduce(
    (acc, c) => ({
      contacts: acc.contacts + (c.totalContacts || 0),
      estimated: acc.estimated + (c.estimatedCost?.total || 0),
      actual: acc.actual + (c.actualCost?.total || 0),
    }),
    { contacts: 0, estimated: 0, actual: 0 }
  );
  const selectedDraftIds = selectedCampaigns.filter((c) => c.status === "draft").map((c) => c.campaignId);
  const selectedScheduledIds = selectedCampaigns.filter((c) => c.status === "scheduled").map((c) => c.campaignId);
  // Bulk delete acts on both — a draft has nothing live yet so it's removed
  // outright, a scheduled campaign has a live EventBridge schedule so
  // bulk-delete.ts cancels it instead (same as the single-row Cancel
  // button), same distinction delete.ts/cancel.ts already draw individually.
  const selectedRemovableIds = [...selectedDraftIds, ...selectedScheduledIds];

  // Chunked to match the backend's per-call cap (bulk-approve.ts) — selecting
  // more than that just means this loops over a few sequential calls instead
  // of one, invisible to the user beyond the button staying disabled longer.
  const BULK_APPROVE_CHUNK = 100;
  const doBulkApprove = async () => {
    setApproving(true);
    try {
      let approvedCount = 0;
      const allSkipped: { campaignId: string; reason: string }[] = [];
      for (let i = 0; i < selectedDraftIds.length; i += BULK_APPROVE_CHUNK) {
        const chunk = selectedDraftIds.slice(i, i + BULK_APPROVE_CHUNK);
        const data = await apiRequest<{ approved: string[]; skipped: { campaignId: string; reason: string }[] }>(
          "/campaigns/bulk-approve",
          { method: "POST", body: JSON.stringify({ campaignIds: chunk }) }
        );
        approvedCount += data.approved.length;
        allSkipped.push(...data.skipped);
      }
      setSelectedMap(new Map());
      loadCampaigns();
      setResultState({
        title: "Bulk approve",
        summary: allSkipped.length > 0 ? `Approved ${approvedCount}. Skipped ${allSkipped.length}.` : `Approved ${approvedCount} campaign${approvedCount !== 1 ? "s" : ""}.`,
        items: allSkipped.map((s) => ({ label: s.campaignId, reason: s.reason })),
      });
    } catch (err) {
      setResultState({ title: "Bulk approve failed", summary: err instanceof Error ? err.message : "Failed to bulk approve" });
    } finally {
      setApproving(false);
    }
  };

  const bulkApprove = () => {
    if (selectedDraftIds.length === 0) return;
    setConfirmState({
      title: "Approve drafts",
      message: `Approve ${selectedDraftIds.length} draft campaign${selectedDraftIds.length !== 1 ? "s" : ""}? Each will be scheduled to send at its set time.`,
      confirmLabel: "Approve",
      onConfirm: doBulkApprove,
    });
  };

  // Same chunking rationale as bulkApprove above, matched to bulk-delete.ts's
  // own per-call cap.
  const BULK_DELETE_CHUNK = 100;
  const doBulkDelete = async () => {
    setBulkDeleting(true);
    try {
      let deletedCount = 0;
      let cancelledCount = 0;
      const allSkipped: { campaignId: string; reason: string }[] = [];
      for (let i = 0; i < selectedRemovableIds.length; i += BULK_DELETE_CHUNK) {
        const chunk = selectedRemovableIds.slice(i, i + BULK_DELETE_CHUNK);
        const data = await apiRequest<{ deleted: string[]; cancelled: string[]; skipped: { campaignId: string; reason: string }[] }>(
          "/campaigns/bulk-delete",
          { method: "POST", body: JSON.stringify({ campaignIds: chunk }) }
        );
        deletedCount += data.deleted.length;
        cancelledCount += data.cancelled.length;
        allSkipped.push(...data.skipped);
      }
      setSelectedMap(new Map());
      loadCampaigns();
      const resultParts = [];
      if (deletedCount > 0) resultParts.push(`Deleted ${deletedCount}`);
      if (cancelledCount > 0) resultParts.push(`Cancelled ${cancelledCount}`);
      const summary = resultParts.length > 0 ? resultParts.join(", ") + "." : "Nothing removed.";
      setResultState({
        title: "Bulk delete",
        summary: allSkipped.length > 0 ? `${summary} Skipped ${allSkipped.length}.` : summary,
        items: allSkipped.map((s) => ({ label: s.campaignId, reason: s.reason })),
      });
    } catch (err) {
      setResultState({ title: "Bulk delete failed", summary: err instanceof Error ? err.message : "Failed to bulk delete" });
    } finally {
      setBulkDeleting(false);
    }
  };

  const bulkDelete = () => {
    if (selectedRemovableIds.length === 0) return;
    const confirmParts = [];
    if (selectedDraftIds.length > 0) confirmParts.push(`Delete ${selectedDraftIds.length} draft${selectedDraftIds.length !== 1 ? "s" : ""}`);
    if (selectedScheduledIds.length > 0) confirmParts.push(`cancel ${selectedScheduledIds.length} scheduled campaign${selectedScheduledIds.length !== 1 ? "s" : ""}`);
    setConfirmState({
      title: "Remove campaigns",
      message: `${confirmParts.join(" and ")}? This cannot be undone.`,
      confirmLabel: "Remove",
      danger: true,
      onConfirm: doBulkDelete,
    });
  };

  const doReschedule = async (date: string, time: string) => {
    if (!reschedulingCampaign) return;
    setReschedulingLoading(true);
    try {
      await apiRequest(`/campaigns/${reschedulingCampaign.campaignId}/reschedule`, {
        method: "PUT",
        body: JSON.stringify({ scheduleDate: date, scheduleTime: time }),
      });
      setReschedulingCampaign(null);
      loadCampaigns();
    } catch {
      setResultState({ title: "Reschedule failed", summary: "Failed to reschedule campaign" });
    } finally {
      setReschedulingLoading(false);
    }
  };

  const SortHeader =({ sortKeyName, children, className }: { sortKeyName: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={className}>
      <button
        onClick={() => toggleSort(sortKeyName)}
        className="flex items-center gap-1 font-medium hover:text-gray-900"
      >
        {children}
        {sortKey === sortKeyName ? (
          sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-30" />
        )}
      </button>
    </th>
  );

  return (
    <AuthGuard>
      <AppShell>
          <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Campaigns</h2>
          <a
            href="/campaigns/new/"
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
          >
            <PlusCircle className="w-4 h-4" />
            New Campaign
          </a>
        </div>

        {/* Search + Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns..."
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-full sm:w-64"
          />
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => handleDateFrom(e.target.value)}
              onBlur={(e) => handleDateFrom(e.target.value)}
              max={dateTo || undefined}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-600"
              aria-label="From date"
            />
            <span className="text-gray-400 text-sm">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => handleDateTo(e.target.value)}
              onBlur={(e) => handleDateTo(e.target.value)}
              min={dateFrom || undefined}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-600"
              aria-label="To date"
            />
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setFilterAndReset("all")}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === "all" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All
          </button>
          {statusFilters.map((s) => (
            <button
              key={s}
              onClick={() => setFilterAndReset(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
                filter === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {s}
            </button>
          ))}
          </div>
        </div>

        {selectedMap.size > 0 && (
          <div className="flex flex-wrap items-center gap-4 mb-4 px-4 py-3 bg-primary-50 border border-primary-200 rounded-lg text-sm">
            <div className="flex items-center gap-2 font-medium text-gray-900">
              <Calculator className="w-4 h-4 text-primary-600" />
              {selectedMap.size} campaign{selectedMap.size !== 1 ? "s" : ""} selected
            </div>
            <span className="text-gray-600">{selectedTotals.contacts.toLocaleString()} contacts</span>
            <span className="text-gray-600">
              Estimated: <span className="font-semibold text-gray-900">₹{selectedTotals.estimated.toFixed(2)}</span>
            </span>
            <span className="text-gray-600">
              Actual (delivered so far): <span className="font-semibold text-gray-900">₹{selectedTotals.actual.toFixed(2)}</span>
            </span>
            {selectedMap.size < totalCount && (
              <button
                onClick={selectAllMatchingFilter}
                disabled={selectingAll}
                className="text-xs text-primary-700 hover:text-primary-900 font-medium disabled:opacity-50"
              >
                {selectingAll ? "Selecting..." : `Select all ${totalCount.toLocaleString()} matching this filter`}
              </button>
            )}
            {selectedDraftIds.length > 0 && (
              <button
                onClick={bulkApprove}
                disabled={approving}
                className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {approving ? "Approving..." : `Approve ${selectedDraftIds.length} draft${selectedDraftIds.length !== 1 ? "s" : ""}`}
              </button>
            )}
            {selectedRemovableIds.length > 0 && (
              <button
                onClick={bulkDelete}
                disabled={bulkDeleting}
                className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {bulkDeleting
                  ? "Removing..."
                  : selectedScheduledIds.length === 0
                  ? `Delete ${selectedDraftIds.length} draft${selectedDraftIds.length !== 1 ? "s" : ""}`
                  : selectedDraftIds.length === 0
                  ? `Cancel ${selectedScheduledIds.length} scheduled`
                  : `Delete/Cancel ${selectedRemovableIds.length}`}
              </button>
            )}
            <button
              onClick={() => setSelectedMap(new Map())}
              className="ml-auto flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
            >
              <X className="w-3 h-3" />
              Clear selection
            </button>
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : campaigns.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <p className="text-gray-500">No campaigns found.</p>
            <a href="/campaigns/new/" className="text-primary-600 text-sm mt-2 inline-block hover:underline">
              Create your first campaign
            </a>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className={`overflow-x-auto ${pageLoading ? "opacity-60" : ""}`}>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={toggleSelectAllOnPage}
                        className="w-4 h-4 text-primary-600 rounded"
                        aria-label="Select all campaigns on this page"
                      />
                    </th>
                    <SortHeader sortKeyName="campaignName" className="text-left px-6 py-3 min-w-[16rem]">Campaign</SortHeader>
                    <SortHeader sortKeyName="created" className="text-left px-6 py-3">Created</SortHeader>
                    <SortHeader sortKeyName="schedule" className="text-left px-6 py-3">Schedule</SortHeader>
                    <SortHeader sortKeyName="status" className="text-left px-6 py-3">Status</SortHeader>
                    <SortHeader sortKeyName="totalContacts" className="text-left px-6 py-3">Contacts</SortHeader>
                    {/* Marks which channel each of the two stacked rows below
                        belongs to, so the numbers don't need repeating icons. */}
                    <th className="px-2 py-3" aria-label="Channel" />
                    <SortHeader sortKeyName="sent" className="text-left px-4 py-3 text-xs">Sent</SortHeader>
                    <SortHeader sortKeyName="delivered" className="text-left px-4 py-3 text-xs">Delivered</SortHeader>
                    <SortHeader sortKeyName="read" className="text-left px-4 py-3 text-xs">Read</SortHeader>
                    {/* WhatsApp row shows replies; email shows clicks — the
                        closest equivalent signal each channel actually has. */}
                    <SortHeader sortKeyName="replies" className="text-left px-4 py-3 text-xs">Replies<span className="text-gray-400"> / Clicks</span></SortHeader>
                    <th className="text-left px-6 py-3 font-medium">
                      Actions
                      <button onClick={checkAllStats} disabled={checkingAll} className="ml-2 text-[10px] text-blue-600 hover:underline disabled:opacity-50">
                        {checkingAll ? "Checking..." : "Check All"}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {campaigns.map((campaign) => (
                    <tr key={campaign.campaignId} className={`hover:bg-gray-50 ${selectedMap.has(campaign.campaignId) ? "bg-primary-50/50" : ""}`}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedMap.has(campaign.campaignId)}
                          onChange={() => toggleSelect(campaign)}
                          className="w-4 h-4 text-primary-600 rounded"
                          aria-label={`Select ${campaign.campaignName}`}
                        />
                      </td>
                      <td className="px-6 py-3 font-medium text-gray-900 max-w-[18rem]">
                        <div className="truncate" title={campaign.campaignName as string}>
                          {campaign.campaignName}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[11px] font-normal">
                            {campaign.businessName}
                          </span>
                          {campaign.respectUnsubscribeList === false && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] font-normal">Incl. unsubscribed</span>
                          )}
                          {campaign.excludePaidUsers === false && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] font-normal">Incl. paid</span>
                          )}
                          {(campaign.status === "scheduled" || campaign.status === "draft") && !!campaign.numberCount && campaign.totalContacts > 0 && (
                            <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[11px] font-normal" title={`${campaign.numberCount} numbers at ${SAFE_MSGS_PER_SECOND}/sec each`}>
                              ~{formatSendDuration(campaign.totalContacts / (SAFE_MSGS_PER_SECOND * campaign.numberCount))} · {campaign.numberCount} nos
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-3 text-gray-500 text-xs">{campaign.createdAt.slice(0, 10)}</td>
                      <td className="px-6 py-3 text-gray-600">{campaign.scheduleDate} {formatTime12h(campaign.scheduleTime)}</td>
                      <td className="px-6 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[campaign.status]}`}>
                          {campaign.status}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-600">{campaign.totalContacts}</td>
                      {(() => {
                        const s = stats[campaign.campaignId];
                        // Same base logic as the campaign detail page's metric
                        // cards: Sent is of total contacts, every stage after it
                        // is of SENT -- dividing a stage by Total understates it
                        // with contacts that were never in play (unsubscribed
                        // skips, sends never accepted). The two screens have to
                        // agree, or the same campaign reads differently on each.
                        const pctOfTotal = (num: number | undefined) =>
                          num != null && campaign.totalContacts ? ` (${Math.round((num / campaign.totalContacts) * 100)}%)` : "";
                        const pctOfSent = (num: number | undefined, base: number | undefined) =>
                          num != null && base ? ` (${Math.round((num / base) * 100)}%)` : "";
                        return (
                          <>
                            {/* Channel markers, aligned with the two value rows
                                in every stat column to their right. */}
                            <td className="px-2 py-3">
                              <div className="flex flex-col gap-1 text-gray-400">
                                <MessageCircle className="w-3.5 h-3.5 text-green-600" aria-label="WhatsApp" />
                                <Mail className="w-3.5 h-3.5 text-blue-600" aria-label="Email" />
                              </div>
                            </td>
                            {([
                              // Sent is the only column measured against the
                              // audience; the rest are measured against Sent.
                              { wa: s?.sent, em: s?.emailSent, waClass: "text-gray-700", base: "total" },
                              { wa: s?.delivered, em: s?.emailDelivered, waClass: "text-green-600", base: "sent" },
                              { wa: s?.read, em: s?.emailOpened, waClass: "text-blue-600", base: "sent" },
                              { wa: s?.replies, em: s?.emailClicked, waClass: "text-purple-600", base: "sent" },
                            ] as const).map((col, i) => (
                              <td key={i} className="px-4 py-3 text-xs">
                                <div className="flex flex-col gap-1">
                                  <span className={col.waClass}>
                                    {s
                                      ? `${col.wa ?? 0}${col.base === "total" ? pctOfTotal(col.wa) : pctOfSent(col.wa, s.sent)}`
                                      : "-"}
                                  </span>
                                  {/* Email is opt-in per campaign, so a dash here
                                      means "not used", not "zero so far". Email
                                      stages are measured against emails SENT,
                                      not WhatsApp sent -- the two channels skip
                                      different people. */}
                                  <span className="text-gray-500">
                                    {s && (s.emailEnabled || s.emailSent)
                                      ? `${col.em ?? 0}${col.base === "total" ? pctOfTotal(col.em) : pctOfSent(col.em, s.emailSent)}`
                                      : "-"}
                                  </span>
                                </div>
                              </td>
                            ))}
                          </>
                        );
                      })()}
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          {/* Check stays visible — it is the one action people use
                              repeatedly. Everything else moves behind the overflow
                              menu so this column stops being the widest thing on
                              the row. */}
                          <button
                            onClick={() => checkStats(campaign.campaignId)}
                            className="text-blue-500 hover:text-blue-700 text-xs font-medium"
                          >
                            Check
                          </button>
                          <RowActionsMenu
                            actions={[
                              { label: "View", href: `/campaigns/view/?id=${campaign.campaignId}` },
                              {
                                label: "Edit",
                                href: `/campaigns/new/?edit=${campaign.campaignId}`,
                                disabled: campaign.status !== "draft",
                              },
                              {
                                label: "Reschedule",
                                disabled: campaign.status !== "scheduled",
                                onClick: () => setReschedulingCampaign(campaign),
                              },
                              {
                                label: duplicatingId === campaign.campaignId ? "Duplicating..." : "Duplicate",
                                onClick: async () => {
                                  setDuplicatingId(campaign.campaignId);
                                  try {
                                    const data = await apiRequest<{ campaignId: string }>(
                                      `/campaigns/${campaign.campaignId}/duplicate`,
                                      { method: "POST" }
                                    );
                                    // Straight into editing the new draft, rather than
                                    // dumping the user back on the list to go find it.
                                    router.push(`/campaigns/new/?edit=${data.campaignId}`);
                                  } catch (err) {
                                    setResultState({
                                      title: "Duplicate failed",
                                      summary: err instanceof Error ? err.message : "Failed to duplicate campaign",
                                    });
                                    setDuplicatingId(null);
                                  }
                                },
                              },
                              {
                                label: deletingId === campaign.campaignId ? "Deleting..." : "Delete",
                                danger: true,
                                disabled: campaign.status !== "draft",
                                onClick: () => {
                                  setConfirmState({
                                    title: "Delete draft",
                                    message: `Delete draft "${campaign.campaignName}"? This cannot be undone.`,
                                    confirmLabel: "Delete",
                                    danger: true,
                                    onConfirm: async () => {
                                      setDeletingId(campaign.campaignId);
                                      try {
                                        await apiRequest(`/campaigns/${campaign.campaignId}`, { method: "DELETE" });
                                        setSelectedMap((prev) => {
                                          if (!prev.has(campaign.campaignId)) return prev;
                                          const next = new Map(prev);
                                          next.delete(campaign.campaignId);
                                          return next;
                                        });
                                        loadCampaigns();
                                      } catch (err) {
                                        setResultState({
                                          title: "Delete failed",
                                          summary: err instanceof Error ? err.message : "Failed to delete campaign",
                                        });
                                      } finally {
                                        setDeletingId(null);
                                      }
                                    },
                                  });
                                },
                              },
                              {
                                label: "Cancel campaign",
                                danger: true,
                                disabled: campaign.status !== "scheduled",
                                onClick: () => {
                                  setConfirmState({
                                    title: "Cancel campaign",
                                    message: "Cancel this campaign?",
                                    confirmLabel: "Cancel campaign",
                                    danger: true,
                                    onConfirm: async () => {
                                      try {
                                        await apiRequest(`/campaigns/${campaign.campaignId}/cancel`, { method: "POST" });
                                        loadCampaigns();
                                      } catch {}
                                    },
                                  });
                                },
                              },
                              {
                                label: "Stop campaign",
                                danger: true,
                                disabled: campaign.status !== "running",
                                onClick: () => {
                                  setConfirmState({
                                    title: "Stop campaign",
                                    message: "Stop this campaign? Contacts not yet reached will not be sent to.",
                                    confirmLabel: "Stop campaign",
                                    danger: true,
                                    onConfirm: async () => {
                                      try {
                                        await apiRequest(`/campaigns/${campaign.campaignId}/cancel`, { method: "POST" });
                                        loadCampaigns();
                                      } catch {}
                                    },
                                  });
                                },
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between px-6 py-3 border-t border-gray-100 text-sm text-gray-600">
              <span>
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount.toLocaleString()}
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || pageLoading}
                  className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Prev
                </button>
                <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || pageLoading}
                  className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        <ConfirmDialog
          state={confirmState}
          loading={confirmLoading}
          onConfirm={runConfirmed}
          onCancel={() => setConfirmState(null)}
        />
        <ResultDialog state={resultState} onClose={() => setResultState(null)} />
        {reschedulingCampaign && (
          <RescheduleDialog
            key={reschedulingCampaign.campaignId}
            open={!!reschedulingCampaign}
            campaignName={reschedulingCampaign.campaignName}
            initialDate={reschedulingCampaign.scheduleDate}
            initialTime={reschedulingCampaign.scheduleTime}
            loading={reschedulingLoading}
            onCancel={() => setReschedulingCampaign(null)}
            onSave={doReschedule}
          />
        )}
      </AppShell>
    </AuthGuard>
  );
}
