"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { ArrowLeft, Send, CheckCircle, Eye, XCircle, MessageSquare, RefreshCw, ChevronLeft, ChevronRight, ChevronDown, Download, Mail } from "lucide-react";
import TemplatePreview from "@/components/campaign/TemplatePreview";
import { TemplateComponent } from "@/types";

interface CampaignDetail {
  campaignId: string;
  campaignName: string;
  businessId: string;
  businessName: string;
  selectedNumbers: { phoneNumberId: string; displayName: string }[];
  templateName: string;
  parameterMapping: Record<string, string>;
  csvS3Key: string;
  headerImageUrl: string;
  totalContacts: number;
  scheduleDate: string;
  scheduleTime: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  respectUnsubscribeList: boolean;
  excludePaidUsers: boolean;
}

interface PreviewTemplate {
  templateName: string;
  components: TemplateComponent[];
}

interface TemplateByNumber {
  phoneNumberId: string;
  displayName: string;
  displayNumber?: string;
  templateName: string | null;
  category?: string | null;
  parameterCount?: number | null;
  status?: string | null;
  found?: boolean;
}

interface Metrics {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replied: number;
  skipped: number;
  // Present only once a campaign has emailed; absent on WhatsApp-only ones.
  emailEnabled?: boolean;
  emailSent?: number;
  emailFailed?: number;
  emailSkipped?: number;
  emailBounced?: number;
  emailComplained?: number;
  emailOpened?: number;
  emailClicked?: number;
}

interface MessageItem {
  phone: string;
  name: string;
  status: string;
  sendingNumber: string;
  errorCode: string | null;
  sentAt: string;
  repliedAt: string | null;
  /** button / auto / other — see backend lib/reply-classifier.ts. Null when not replied. */
  replyType: ReplyType | null;
  /** What they replied, successive replies joined with " | ". */
  replyText: string | null;
  /** The contact's address, or null when their CSV row carried none. */
  email: string | null;
  /**
   * The furthest point this contact's email reached, or null if the campaign
   * did not email or predates per-recipient email tracking.
   */
  emailStatus: string | null;
  emailReason: string | null;
}

// Mirrors backend/src/lib/error-codes.ts, sourced from Meta's official error
// code reference (message-send-relevant codes only):
// https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes/
const ERROR_MESSAGES: Record<string, string> = {
  "0": "Unable to authenticate the app user — access token needs replacing",
  "3": "Capability or permissions issue on this app/token",
  "10": "Permission not granted or has been removed",
  "190": "Access token has expired",
  "200": "No access token was provided",
  "368": "WhatsApp Business Account restricted or disabled for a policy violation",
  "130497": "WhatsApp Business Account restricted from messaging users in this country",
  "131031": "Account restricted or disabled — policy violation or failed data verification",
  "4": "App has reached its API call rate limit",
  "80007": "WhatsApp Business Account rate limit reached",
  "130429": "Cloud API message throughput limit reached",
  "131048": "Message restricted — recipient blocked or messages flagged as spam",
  "131056": "Too many messages sent to the same recipient in a short period",
  "131064": "Messaging limit reached due to template classification violations (auto-lifts)",
  "133016": "Too many registration/deregistration attempts in a short period",
  "1": "Invalid request or possible server error",
  "2": "Temporary downtime or server overload",
  "33": "Business phone number has been deleted",
  "100": "Request includes an unsupported or misspelled parameter",
  "130403": "Business has blocked this end user on WhatsApp",
  "130472": "Message not sent as part of a marketing message experiment",
  "131000": "Message failed to send due to an unknown error",
  "131005": "Permission not granted or has been removed",
  "131008": "Request is missing a required parameter",
  "131009": "One or more parameter values are invalid",
  "131016": "Service temporarily unavailable",
  "131021": "Sender and recipient phone number are the same",
  "131026": "Not on WhatsApp, using an old WhatsApp version, or hasn't accepted new Terms of Service",
  "131037": "Business phone number lacks an approved display name",
  "131042": "Payment issue — verify billing setup and credit line status",
  "131045": "Phone number registration error",
  "131047": "More than 24 hours since the recipient last replied (send a template instead)",
  "131049": "Not delivered for ecosystem engagement health reasons — wait 24 hours before resending",
  "131050": "Recipient has stopped receiving marketing messages — do not retry",
  "131051": "Unsupported message type",
  "131052": "Unable to download media sent by the user",
  "131053": "Unable to upload media used in the message",
  "131057": "Business Account is in maintenance mode",
  "131063": "Template categorized as Marketing but disabled on Cloud API",
  "132000": "Number of variable parameter values does not match the template definition",
  "132001": "Template does not exist or is not approved",
  "132005": "Template hydration failed — translated text too long",
  "132007": "Template content violates WhatsApp policy",
  "132012": "Variable parameter values are formatted incorrectly",
  "132015": "Template paused due to low quality",
  "132016": "Template permanently disabled due to repeated low-quality pauses",
  "132068": "Flow is in a blocked state",
  "132069": "Flow throttled — too many messages sent in the last hour",
  "133000": "Previous deregistration attempt failed",
  "133004": "Server temporarily unavailable",
  "133005": "Two-step verification PIN incorrect",
  "133006": "Phone number needs verification before registering",
  "133008": "Too many two-step verification PIN guesses — retry after the cooldown",
  "133009": "Two-step verification PIN entered too quickly — retry after a short wait",
  "133010": "Phone number is not registered on the WhatsApp platform",
  "133015": "Phone number was recently deleted — wait a few minutes before retrying",
  "134011": "WhatsApp Payments terms of service acceptance pending",
  "135000": "Unknown error with request parameters",
  "unsubscribed": "Unsubscribed",
  "already_paid": "Already paid (masterclass)",
};

// Mirrors backend/src/lib/capacity.ts's safe per-number pace — kept in sync
// manually since frontend and backend don't share a module here.
const SAFE_MSGS_PER_SECOND = 5;

function formatDuration(ms: number): string {
  if (ms < 60000) return "under a minute";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  scheduled: "bg-yellow-100 text-yellow-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

// The email funnel has its own vocabulary — "opened"/"clicked" have no
// WhatsApp equivalent, and "bounced" is a harder failure than "failed".
const emailStatusColors: Record<string, string> = {
  sent: "text-blue-600",
  delivered: "text-green-600",
  opened: "text-purple-600",
  clicked: "text-indigo-600",
  bounced: "text-red-600",
  spam: "text-red-700",
  failed: "text-red-600",
  skipped: "text-orange-500",
};

const msgStatusColors: Record<string, string> = {
  queued: "text-gray-500",
  sent: "text-blue-600",
  delivered: "text-green-600",
  read: "text-purple-600",
  failed: "text-red-600",
  skipped: "text-orange-500",
  replied: "text-indigo-600",
};

type ReplyType = "button" | "auto" | "other";

// Replies split by what kind they were. "auto" is a guess (instant arrival or
// stock greeting-message wording) — the label says so.
const REPLY_TYPE_LABELS: Record<ReplyType, string> = {
  button: "Button click",
  auto: "Auto-reply (guessed)",
  other: "Other",
};
const REPLY_TYPE_COLORS: Record<ReplyType, string> = {
  button: "bg-emerald-600 text-white",
  auto: "bg-gray-500 text-white",
  other: "bg-indigo-600 text-white",
};
const REPLY_TYPE_TEXT: Record<ReplyType, string> = {
  button: "text-emerald-600",
  auto: "text-gray-400",
  other: "text-indigo-600",
};

type StatusFilter = "all" | "sent" | "delivered" | "read" | "failed" | "skipped" | "replied" | null;

// Skipped rows reuse the errorCode field to record WHY they were suppressed.
// These are deliberate skips, not failures — worth spelling out, since
// "already paid" and "asked to stop" mean very different things for follow-up.
const SKIP_REASONS: Record<string, string> = {
  unsubscribed: "Asked to stop",
  already_paid: "Already a paid customer",
  campaign_cancelled: "Campaign was cancelled",
};
const skipReasonLabel = (code?: string | null) => (code ? SKIP_REASONS[code] || code : "-");

export default function CampaignViewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-gray-400">Loading...</p></div>}>
      <CampaignViewContent />
    </Suspense>
  );
}

function CampaignViewContent() {
  const searchParams = useSearchParams();
  const campaignId = searchParams?.get("id") || "";

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  // Same test the Email stats row uses, so the column and the stats agree.
  const campaignEmails = Boolean(metrics && (metrics.emailEnabled || (metrics.emailSent ?? 0) > 0));
  const [cost, setCost] = useState<{ perMessage: number; total: number } | null>(null);
  const [templateByNumber, setTemplateByNumber] = useState<TemplateByNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewTemplate, setPreviewTemplate] = useState<PreviewTemplate | null>(null);
  const [previewRow, setPreviewRow] = useState<Record<string, string> | null>(null);

  // Message list state
  const [activeFilter, setActiveFilter] = useState<StatusFilter>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalMsgs, setTotalMsgs] = useState(0);
  const [errorCodeFilter, setErrorCodeFilter] = useState<string | null>(null);
  const [errorCodeBreakdown, setErrorCodeBreakdown] = useState<Record<string, number>>({});
  const [errorCodeRetryable, setErrorCodeRetryable] = useState<Record<string, boolean>>({});
  const [replyTypeFilter, setReplyTypeFilter] = useState<ReplyType | null>(null);
  const [replyTypeBreakdown, setReplyTypeBreakdown] = useState<Record<ReplyType, number> | null>(null);

  // Action state
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<{ retried: number; skipped: number; message: string } | null>(null);
  const [showRetryPicker, setShowRetryPicker] = useState(false);
  const [retrySelection, setRetrySelection] = useState<Set<string> | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeResult, setResumeResult] = useState<{ resumed: number; message: string } | null>(null);
  const [downloadingCsv, setDownloadingCsv] = useState(false);

  useEffect(() => { if (campaignId) loadCampaign(); }, [campaignId]);

  // Loads the actual template body + one real contact row from the
  // campaign's own CSV, so the preview shows genuine values (a real name,
  // real workshop_date, real zoom_link, etc.) instead of placeholder text —
  // same source of truth send.ts itself reads from.
  useEffect(() => {
    if (!campaign) return;
    (async () => {
      if (campaign.templateName && campaign.businessId && campaign.selectedNumbers?.length) {
        try {
          const numberIds = campaign.selectedNumbers.map((n) => n.phoneNumberId).join(",");
          const data = await apiRequest<{ templates: PreviewTemplate[] }>(
            `/templates?businessId=${campaign.businessId}&phoneNumberIds=${numberIds}`
          );
          setPreviewTemplate(data.templates.find((t) => t.templateName === campaign.templateName) || null);
        } catch {
          setPreviewTemplate(null);
        }
      }
      if (campaign.csvS3Key) {
        try {
          const data = await apiRequest<{ preview: Record<string, string>[] }>(
            `/campaigns/file-preview?s3Key=${encodeURIComponent(campaign.csvS3Key)}`
          );
          setPreviewRow(data.preview?.[0] || null);
        } catch {
          setPreviewRow(null);
        }
      }
    })();
  }, [campaign]);

  // Resolves each {{n}} to its real value: a __STATIC__-prefixed mapping is
  // already a literal value (same for every contact); anything else is a CSV
  // column name, resolved against the real first row pulled above.
  const resolvedValues: Record<string, string> = campaign
    ? Object.fromEntries(
        Object.entries(campaign.parameterMapping || {}).map(([idx, mapping]) => {
          if (mapping.startsWith("__STATIC__")) return [idx, mapping.slice("__STATIC__".length)];
          const value = previewRow?.[mapping];
          return [idx, value !== undefined ? value : `[${mapping}]`];
        })
      )
    : {};

  useEffect(() => {
    if (activeFilter && campaignId) loadMessages(activeFilter, 1, errorCodeFilter);
  }, [activeFilter, errorCodeFilter, replyTypeFilter]);

  const loadCampaign = async () => {
    try {
      const data = await apiRequest<{
        campaign: CampaignDetail;
        metrics: Metrics;
        cost: { perMessage: number; total: number };
        templateByNumber?: TemplateByNumber[];
      }>(`/campaigns/${campaignId}`);
      setCampaign(data.campaign);
      setMetrics(data.metrics);
      setCost(data.cost);
      setTemplateByNumber(data.templateByNumber || []);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (status: StatusFilter, p: number, errorCode?: string | null) => {
    if (!status) return;
    setMsgLoading(true);
    try {
      const codeParam = (errorCode ? `&errorCode=${encodeURIComponent(errorCode)}` : "") + replyTypeParam(status);
      const data = await apiRequest<{
        messages: MessageItem[];
        total: number;
        page: number;
        totalPages: number;
        errorCodeBreakdown?: Record<string, number>;
        errorCodeRetryable?: Record<string, boolean>;
        replyTypeBreakdown?: Record<ReplyType, number>;
      }>(`/campaigns/${campaignId}?status=${status}&page=${p}&limit=50${codeParam}`);
      setMessages(data.messages);
      setPage(data.page);
      setTotalPages(data.totalPages);
      setTotalMsgs(data.total);
      if (data.errorCodeBreakdown) setErrorCodeBreakdown(data.errorCodeBreakdown);
      if (data.errorCodeRetryable) setErrorCodeRetryable(data.errorCodeRetryable);
      setReplyTypeBreakdown(data.replyTypeBreakdown || null);
    } catch {
      setMessages([]);
    } finally {
      setMsgLoading(false);
    }
  };

  // Reason breakdown is normally only fetched when the user opens the "failed"
  // message list (loadMessages above) — but the retry reason-picker needs it
  // the moment it's opened, which can happen without ever viewing that list.
  // limit=1 keeps this cheap: errorCodeBreakdown/errorCodeRetryable are computed
  // server-side over the FULL failed set regardless of the page size requested.
  const ensureBreakdownLoaded = async () => {
    if (Object.keys(errorCodeBreakdown).length > 0 || breakdownLoading) return;
    setBreakdownLoading(true);
    try {
      const data = await apiRequest<{
        errorCodeBreakdown?: Record<string, number>;
        errorCodeRetryable?: Record<string, boolean>;
      }>(`/campaigns/${campaignId}?status=failed&page=1&limit=1`);
      if (data.errorCodeBreakdown) setErrorCodeBreakdown(data.errorCodeBreakdown);
      if (data.errorCodeRetryable) setErrorCodeRetryable(data.errorCodeRetryable);
    } catch {
    } finally {
      setBreakdownLoading(false);
    }
  };

  const replyTypeParam = (status: StatusFilter) =>
    status === "replied" && replyTypeFilter ? `&replyType=${replyTypeFilter}` : "";

  const handleFilterClick = (status: StatusFilter) => {
    if (activeFilter === status) {
      setActiveFilter(null);
      setMessages([]);
    } else {
      setActiveFilter(status);
      setPage(1);
      setErrorCodeFilter(null);
      setReplyTypeFilter(null);
    }
  };

  const handleRetry = async (codes?: string[]) => {
    if (!campaignId || retrying) return;
    setRetrying(true);
    setRetryResult(null);
    setShowRetryPicker(false);
    try {
      const data = await apiRequest<{ retried: number; skipped: number; message: string }>(
        `/campaigns/${campaignId}/retry`,
        { method: "POST", body: JSON.stringify(codes && codes.length > 0 ? { errorCodes: codes } : {}) }
      );
      setRetryResult(data);
      setRetrySelection(null);
      setTimeout(() => loadCampaign(), 2000);
    } catch {
      setRetryResult({ retried: 0, skipped: 0, message: "Retry failed. Please try again." });
    } finally {
      setRetrying(false);
    }
  };

  const handleResume = async () => {
    if (!campaignId || resuming) return;
    setResuming(true);
    setResumeResult(null);
    try {
      const data = await apiRequest<{ resumed: number; message: string }>(
        `/campaigns/${campaignId}/resume`, { method: "POST" }
      );
      setResumeResult(data);
      setTimeout(() => loadCampaign(), 3000);
    } catch {
      setResumeResult({ resumed: 0, message: "Resume failed. Please try again." });
    } finally {
      setResuming(false);
    }
  };

  // Quote a CSV field if it contains a comma, quote, or newline — a plain join(",")
  // would silently misalign columns the moment a name or error message has a comma in it.
  const toCsvField = (value: unknown): string => {
    const str = value == null ? "" : String(value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };

  const handleDownloadCsv = async () => {
    if (!activeFilter || !campaignId || downloadingCsv) return;
    setDownloadingCsv(true);
    try {
      // The visible table only holds the current page (50 rows) — pull every page
      // for this filter so the export has all matching messages, not just what's shown.
      const codeParam = (errorCodeFilter ? `&errorCode=${encodeURIComponent(errorCodeFilter)}` : "") + replyTypeParam(activeFilter);
      const all: MessageItem[] = [];
      let p = 1;
      let pages = 1;
      do {
        const data = await apiRequest<{ messages: MessageItem[]; totalPages: number }>(
          `/campaigns/${campaignId}?status=${activeFilter}&page=${p}&limit=200${codeParam}`
        );
        all.push(...data.messages);
        pages = data.totalPages;
        p++;
      } while (p <= pages);

      const headers = ["Phone", "Name", "Sent From", "Status", "Sent At"];
      if (campaignEmails) headers.push("Email", "Email Status", "Email Reason");
      if (activeFilter === "failed") headers.push("Error Code", "Error");
      if (activeFilter === "skipped" || activeFilter === "all") headers.push("Reason");
      if (activeFilter === "replied") headers.push("Replied At", "Reply Type", "Reply");

      const rows = all.map((msg) => {
        const row = [
          msg.phone,
          msg.name || "",
          msg.sendingNumber || "",
          msg.status,
          msg.sentAt ? new Date(msg.sentAt).toLocaleString() : "",
        ];
        if (campaignEmails) {
          row.push(msg.email || "", msg.emailStatus || "", msg.emailReason || "");
        }
        if (activeFilter === "failed") {
          row.push(msg.errorCode || "");
          row.push(msg.errorCode ? (ERROR_MESSAGES[msg.errorCode] || "Unknown") : "");
        }
        if (activeFilter === "skipped" || activeFilter === "all") {
          row.push(
            msg.status === "skipped"
              ? skipReasonLabel(msg.errorCode)
              : msg.status === "failed" && msg.errorCode
              ? `${ERROR_MESSAGES[msg.errorCode] || "Unknown"} (${msg.errorCode})`
              : ""
          );
        }
        if (activeFilter === "replied") {
          row.push(
            msg.repliedAt ? new Date(msg.repliedAt).toLocaleString() : "",
            msg.replyType ? REPLY_TYPE_LABELS[msg.replyType] : "",
            msg.replyText || ""
          );
        }
        return row;
      });

      const csv = [headers, ...rows].map((r) => r.map(toCsvField).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const suffix = activeFilter === "replied" && replyTypeFilter ? `_${replyTypeFilter}` : "";
      a.download = `${campaign?.campaignName || campaignId}_${activeFilter}${suffix}.csv`;
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
    <AuthGuard>
      <AppShell>
          {loading ? (
            <p className="text-gray-400 text-sm">Loading...</p>
          ) : !campaign ? (
            <p className="text-gray-500">Campaign not found</p>
          ) : (
            <div className="max-w-6xl">

              {/* Header */}
              <div className="flex items-center gap-3 mb-6">
                <a href="/campaigns/" className="text-gray-400 hover:text-gray-600">
                  <ArrowLeft className="w-5 h-5" />
                </a>
                <div className="flex-1">
                  <h2 className="text-2xl font-bold text-gray-900">{campaign.campaignName}</h2>
                  <p className="text-sm text-gray-500">
                    {campaign.businessName} • {campaign.templateName} •{" "}
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[campaign.status]}`}>
                      {campaign.status}
                    </span>
                  </p>
                </div>
                {metrics && metrics.failed > 0 && (
                  <div className="relative">
                    <div className="flex items-stretch rounded-lg overflow-hidden">
                      <button onClick={() => handleRetry()} disabled={retrying}
                        className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white text-sm font-medium transition-colors">
                        <RefreshCw className={`w-4 h-4 ${retrying ? "animate-spin" : ""}`} />
                        {retrying ? "Retrying..." : `Retry Failed (${metrics.failed})`}
                      </button>
                      <button
                        onClick={() => { const opening = !showRetryPicker; setShowRetryPicker(opening); if (opening) ensureBreakdownLoaded(); }}
                        disabled={retrying}
                        title="Choose which failure reasons to retry"
                        className="flex items-center px-2 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white border-l border-red-500/60 transition-colors"
                      >
                        <ChevronDown className={`w-4 h-4 transition-transform ${showRetryPicker ? "rotate-180" : ""}`} />
                      </button>
                    </div>

                    {showRetryPicker && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowRetryPicker(false)} />
                        <div className="absolute right-0 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-20 text-sm">
                          <div className="px-3 py-2 border-b border-gray-100 text-xs text-gray-500">
                            Retry only selected reasons — reasons with no benefit (e.g. invalid/old-WhatsApp numbers) are disabled.
                          </div>
                          {breakdownLoading ? (
                            <div className="px-3 py-4 text-center text-gray-400 text-xs">Loading reasons...</div>
                          ) : Object.keys(errorCodeBreakdown).length === 0 ? (
                            <div className="px-3 py-4 text-center text-gray-400 text-xs">No failure data available</div>
                          ) : (
                            <>
                              <div className="max-h-64 overflow-y-auto">
                                {Object.entries(errorCodeBreakdown)
                                  .sort(([, a], [, b]) => b - a)
                                  .map(([code, count]) => {
                                    const codeRetryable = errorCodeRetryable[code] ?? false;
                                    const checked = codeRetryable && (retrySelection ? retrySelection.has(code) : true);
                                    return (
                                      <label key={code}
                                        className={`flex items-start gap-2 px-3 py-2 border-b border-gray-50 last:border-0 ${
                                          codeRetryable ? "cursor-pointer hover:bg-gray-50" : "opacity-50 cursor-not-allowed"
                                        }`}
                                      >
                                        <input
                                          type="checkbox"
                                          className="mt-0.5"
                                          disabled={!codeRetryable}
                                          checked={checked}
                                          onChange={(e) => {
                                            setRetrySelection((prev) => {
                                              const base = prev ?? new Set(Object.keys(errorCodeBreakdown).filter((c) => errorCodeRetryable[c]));
                                              const next = new Set(base);
                                              if (e.target.checked) next.add(code); else next.delete(code);
                                              return next;
                                            });
                                          }}
                                        />
                                        <span className="flex-1">
                                          <span className="block text-gray-700">
                                            {code === "Unknown" ? "Unknown" : (ERROR_MESSAGES[code] || "Unknown")} ({code})
                                          </span>
                                          <span className="text-xs text-gray-400">
                                            {count} message{count === 1 ? "" : "s"}{!codeRetryable ? " — no benefit retrying" : ""}
                                          </span>
                                        </span>
                                      </label>
                                    );
                                  })}
                              </div>
                              {(() => {
                                const selectedCodes = retrySelection
                                  ? Array.from(retrySelection)
                                  : Object.keys(errorCodeBreakdown).filter((c) => errorCodeRetryable[c]);
                                const selectedCount = selectedCodes.reduce((sum, c) => sum + (errorCodeBreakdown[c] || 0), 0);
                                return (
                                  <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100">
                                    <button onClick={() => setShowRetryPicker(false)} className="text-xs text-gray-500 hover:text-gray-700">
                                      Cancel
                                    </button>
                                    <button
                                      onClick={() => handleRetry(selectedCodes)}
                                      disabled={retrying || selectedCodes.length === 0}
                                      className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white text-xs font-medium rounded-md transition-colors"
                                    >
                                      Retry Selected ({selectedCount})
                                    </button>
                                  </div>
                                );
                              })()}
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {campaign.status === "running" && (
                  <button onClick={handleResume} disabled={resuming}
                    className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white text-sm font-medium rounded-lg transition-colors">
                    <RefreshCw className={`w-4 h-4 ${resuming ? "animate-spin" : ""}`} />
                    {resuming ? "Resuming..." : "Resume Stuck"}
                  </button>
                )}
              </div>

              {/* Banners */}
              {retryResult && (
                <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${retryResult.retried > 0 ? "bg-green-50 border border-green-200 text-green-800" : "bg-yellow-50 border border-yellow-200 text-yellow-800"}`}>
                  {retryResult.message}
                  {retryResult.retried > 0 && <span className="ml-2 font-medium">Queued {retryResult.retried} for retry.</span>}
                  {retryResult.skipped > 0 && <span className="ml-2 text-gray-500">{retryResult.skipped} non-retryable skipped.</span>}
                </div>
              )}
              {resumeResult && (
                <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${resumeResult.resumed > 0 ? "bg-orange-50 border border-orange-200 text-orange-800" : "bg-green-50 border border-green-200 text-green-800"}`}>
                  {resumeResult.message}
                  {resumeResult.resumed > 0 && <span className="ml-2 font-medium">Re-queued {resumeResult.resumed} stuck contacts.</span>}
                </div>
              )}

              {/* Metric Cards — click to filter messages below */}
              {metrics && (() => {
                const skipped = metrics.skipped || 0;
                // Delivered/Read/Replied are measured against SENT: Total
                // includes contacts that were never in play (unsubscribed skips,
                // sends never accepted), so dividing by it understates how each
                // stage actually converted.
                //
                // Sent and Failed stay against Total. Both answer a question
                // about the AUDIENCE rather than about conversion -- "how much
                // of my list did we reach" and "how much of my list could not
                // be reached". Failed against Sent would also be odd arithmetic,
                // since the two are disjoint: a message is either accepted or it
                // failed, never both at send time.
                const ofSent = (n: number) => (metrics.sent ? Math.round((n / metrics.sent) * 100) : 0);
                const items: { label: string; value: number; icon: React.ElementType; color: string; activeColor: string; pct: number | null; filter: StatusFilter }[] = [
                  { label: "Total",     value: metrics.total,     icon: Send,          color: "text-gray-600",   activeColor: "border-gray-400 bg-gray-50",    pct: null,                                                                                       filter: "all" },
                  { label: "Sent",      value: metrics.sent,      icon: Send,          color: "text-blue-600",   activeColor: "border-blue-400 bg-blue-50",    pct: metrics.total ? Math.round((metrics.sent      / metrics.total) * 100) : 0, filter: "sent" },
                  { label: "Delivered", value: metrics.delivered, icon: CheckCircle,   color: "text-green-600",  activeColor: "border-green-400 bg-green-50",  pct: ofSent(metrics.delivered), filter: "delivered" },
                  { label: "Read",      value: metrics.read,      icon: Eye,           color: "text-purple-600", activeColor: "border-purple-400 bg-purple-50",pct: ofSent(metrics.read),      filter: "read" },
                  { label: "Failed",    value: metrics.failed,    icon: XCircle,       color: "text-red-600",    activeColor: "border-red-400 bg-red-50",      pct: metrics.total ? Math.round((metrics.failed / metrics.total) * 100) : 0, filter: "failed" },
                  { label: "Skipped",   value: skipped,           icon: XCircle,       color: "text-orange-500", activeColor: "border-orange-400 bg-orange-50",pct: null,                      filter: "skipped" },
                  { label: "Replied",   value: metrics.replied,   icon: MessageSquare, color: "text-indigo-600", activeColor: "border-indigo-400 bg-indigo-50",pct: ofSent(metrics.replied),   filter: "replied" },
                ];
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
                    {items.map((m) => (
                      <button
                        key={m.label}
                        onClick={() => m.filter && handleFilterClick(m.filter)}
                        className={`bg-white rounded-lg border-2 p-3 text-left transition-all ${
                          m.filter
                            ? activeFilter === m.filter
                              ? `${m.activeColor} cursor-pointer`
                              : "border-gray-200 hover:border-gray-300 cursor-pointer"
                            : "border-gray-200 cursor-default"
                        }`}
                      >
                        <m.icon className={`w-4 h-4 ${m.color} mb-1`} />
                        <p className="text-xl font-bold text-gray-900">{m.value}</p>
                        <p className="text-xs text-gray-500">{m.label}</p>
                        {m.pct !== null && m.value > 0 && (
                          <p className={`text-xs font-medium mt-0.5 ${m.color}`}>{m.pct}%</p>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })()}

              <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 items-start">
              <div>
              {/* Campaign Info */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
                <h3 className="font-semibold text-gray-900 mb-3">Campaign Info</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-gray-500">Schedule:</span> <span className="text-gray-900">{campaign.scheduleDate} {campaign.scheduleTime}</span></div>
                  <div><span className="text-gray-500">Contacts:</span> <span className="text-gray-900">{campaign.totalContacts}</span></div>
                  <div><span className="text-gray-500">Numbers:</span> <span className="text-gray-900">{campaign.selectedNumbers?.length || 0}</span></div>
                  <div><span className="text-gray-500">Created:</span> <span className="text-gray-900">{new Date(campaign.createdAt).toLocaleString()}</span></div>
                  <div><span className="text-gray-500">Skip unsubscribed:</span> <span className={campaign.respectUnsubscribeList ? "text-gray-900" : "text-amber-700 font-medium"}>{campaign.respectUnsubscribeList ? "Yes" : "No — sends to them too"}</span></div>
                  <div><span className="text-gray-500">Skip paid users:</span> <span className={campaign.excludePaidUsers ? "text-gray-900" : "text-amber-700 font-medium"}>{campaign.excludePaidUsers ? "Yes" : "No — sends to them too"}</span></div>
                  {(campaign.status === "scheduled" || campaign.status === "draft") && campaign.totalContacts > 0 && campaign.selectedNumbers?.length > 0 && (
                    <div>
                      <span className="text-gray-500">Est. time to send:</span>{" "}
                      <span className="text-gray-900 font-medium">
                        ~{formatDuration((campaign.totalContacts / (SAFE_MSGS_PER_SECOND * campaign.selectedNumbers.length)) * 1000)}
                        {campaign.scheduleDate && campaign.scheduleTime && (() => {
                          const start = new Date(`${campaign.scheduleDate}T${campaign.scheduleTime}:00+05:30`).getTime();
                          if (isNaN(start)) return null;
                          const end = new Date(start + (campaign.totalContacts / (SAFE_MSGS_PER_SECOND * campaign.selectedNumbers.length)) * 1000);
                          return ` (done by ~${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
                        })()}
                      </span>
                    </div>
                  )}
                  {metrics && (metrics.emailEnabled || (metrics.emailSent ?? 0) > 0) && (
                    <div className="mt-4 bg-white border border-gray-200 rounded-xl px-5 py-4">
                      <div className="flex items-center gap-2 mb-3">
                        <Mail className="w-4 h-4 text-gray-500" />
                        <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Email</h3>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                        {[
                          { label: "Sent", value: metrics.emailSent ?? 0, color: "text-blue-600" },
                          { label: "Skipped", value: metrics.emailSkipped ?? 0, color: "text-gray-500" },
                          { label: "Failed", value: metrics.emailFailed ?? 0, color: "text-red-600" },
                          { label: "Bounced", value: (metrics.emailBounced ?? 0) + (metrics.emailComplained ?? 0), color: "text-amber-600" },
                          { label: "Clicked", value: metrics.emailClicked ?? 0, color: "text-green-600" },
                          { label: "Opened*", value: metrics.emailOpened ?? 0, color: "text-gray-400" },
                        ].map((c) => (
                          <div key={c.label}>
                            <p className="text-xs text-gray-500">{c.label}</p>
                            <p className={`text-xl font-semibold ${c.color}`}>{c.value.toLocaleString()}</p>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-gray-400 mt-2">
                        Skipped covers contacts with no email address, an unsubscribe, a past hard bounce, or a
                        missing link the copy needs. Bounced counts hard bounces and spam complaints, both of
                        which suppress that address permanently. Clicked is a real link click — the number
                        worth acting on. *Opened runs high: Apple Mail and Gmail fetch the tracking pixel
                        whether or not anyone reads the mail, so use it to compare sends, not to count people.
                      </p>
                    </div>
                  )}

                  {campaign.status === "running" && metrics && metrics.queued > 0 && campaign.selectedNumbers?.length > 0 && (() => {
                    const remainingMinutes = metrics.queued / (SAFE_MSGS_PER_SECOND * campaign.selectedNumbers.length * 60);
                    const eta = new Date(Date.now() + remainingMinutes * 60 * 1000);
                    const etaLabel = eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                    const minutesLeft = Math.ceil(remainingMinutes);
                    return (
                      <div>
                        <span className="text-gray-500">Est. delivery end:</span>{" "}
                        <span className="text-gray-900 font-medium">
                          {etaLabel} (~{minutesLeft} min{minutesLeft === 1 ? "" : "s"} left, {metrics.queued} remaining)
                        </span>
                      </div>
                    );
                  })()}
                  {campaign.status === "completed" && campaign.startedAt && campaign.completedAt && (() => {
                    const ms = new Date(campaign.completedAt).getTime() - new Date(campaign.startedAt).getTime();
                    if (ms < 0) return null;
                    return (
                      <div>
                        <span className="text-gray-500">Time taken:</span>{" "}
                        <span className="text-gray-900 font-medium">{formatDuration(ms)}</span>
                      </div>
                    );
                  })()}
                </div>
                {cost && (
                  <div className="mt-3 pt-3 border-t border-gray-200 flex items-center gap-4">
                    <div>
                      <p className="text-xs text-gray-500">Actual Cost (delivered)</p>
                      <p className="text-lg font-bold text-gray-900">₹{cost.total.toFixed(2)}</p>
                    </div>
                    <p className="text-xs text-gray-400">₹{cost.perMessage}/msg × {metrics?.delivered || 0} delivered</p>
                  </div>
                )}
              </div>

              {/* Template by Number — each number's copy of the template can drift
                  independently (paused, disabled, re-categorized), so worth showing
                  per-number rather than just the one templateName/category on the
                  campaign as a whole. Useful for cross-checking a "Template disabled"
                  / "Template paused" failure reason in the message list below. */}
              {templateByNumber.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
                  <div className="px-5 py-3 border-b border-gray-200">
                    <h3 className="font-semibold text-gray-900">Template by Number</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-gray-600">
                        <tr>
                          <th className="text-left px-5 py-2 font-medium">Number</th>
                          <th className="text-left px-5 py-2 font-medium">Template</th>
                          <th className="text-left px-5 py-2 font-medium">Category</th>
                          <th className="text-left px-5 py-2 font-medium">Params</th>
                          <th className="text-left px-5 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {templateByNumber.map((t) => (
                          <tr key={t.phoneNumberId} className="hover:bg-gray-50">
                            <td className="px-5 py-2 text-gray-900">
                              {t.displayName}{t.displayNumber ? ` (${t.displayNumber})` : ""}
                            </td>
                            <td className="px-5 py-2 text-gray-700">{t.templateName || "-"}</td>
                            <td className="px-5 py-2">
                              {t.category ? (
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                  t.category === "MARKETING" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                                }`}>
                                  {t.category}
                                </span>
                              ) : "-"}
                            </td>
                            <td className="px-5 py-2 text-gray-500">{t.parameterCount ?? "-"}</td>
                            <td className="px-5 py-2">
                              {t.found === false ? (
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Not found on this number</span>
                              ) : t.status ? (
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                                  t.status === "approved" ? "bg-green-100 text-green-700" :
                                  t.status === "paused" || t.status === "disabled" ? "bg-red-100 text-red-700" :
                                  "bg-gray-100 text-gray-600"
                                }`}>
                                  {t.status}
                                </span>
                              ) : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              </div>

              {/* Message preview — sticky alongside Campaign Info / Template by
                  Number, resolved with real values (a real contact row from
                  this campaign's own CSV), not placeholder text. */}
              <div className="lg:sticky lg:top-4">
                <h3 className="font-semibold text-gray-900 mb-3">Message Preview</h3>
                <TemplatePreview
                  template={previewTemplate}
                  resolvedValues={resolvedValues}
                  headerImageUrl={campaign.headerImageUrl}
                />
              </div>
              </div>

              {/* Message List — shown when a filter card is clicked */}
              {activeFilter && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900 capitalize">
                      {activeFilter} messages
                      {totalMsgs > 0 && <span className="ml-2 text-sm text-gray-400 font-normal">({totalMsgs} total)</span>}
                    </h3>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleDownloadCsv}
                        disabled={downloadingCsv || messages.length === 0}
                        className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 border border-gray-300 rounded-lg px-2.5 py-1.5 disabled:opacity-40 transition-colors"
                      >
                        <Download className={`w-3.5 h-3.5 ${downloadingCsv ? "animate-pulse" : ""}`} />
                        {downloadingCsv ? "Preparing…" : "Download CSV"}
                      </button>
                      <button onClick={() => { setActiveFilter(null); setMessages([]); setErrorCodeFilter(null); setReplyTypeFilter(null); }} className="text-xs text-gray-400 hover:text-gray-600">✕ Close</button>
                    </div>
                  </div>

                  {/* Filter by failure reason — built from errorCodeBreakdown so it
                      always reflects every code actually present, not just this page. */}
                  {(activeFilter === "failed" || activeFilter === "skipped") && Object.keys(errorCodeBreakdown).length > 0 && (
                    <div className="px-5 py-2.5 border-b border-gray-100 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-gray-400 mr-1">Filter by reason:</span>
                      <button
                        onClick={() => setErrorCodeFilter(null)}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                          errorCodeFilter === null ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                        }`}
                      >
                        All ({Object.values(errorCodeBreakdown).reduce((a, b) => a + b, 0)})
                      </button>
                      {Object.entries(errorCodeBreakdown)
                        .sort(([, a], [, b]) => b - a)
                        .map(([code, count]) => (
                          <button
                            key={code}
                            onClick={() => setErrorCodeFilter(code)}
                            className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                              errorCodeFilter === code
                                ? activeFilter === "skipped"
                                  ? "bg-orange-500 text-white"
                                  : "bg-red-600 text-white"
                                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            }`}
                          >
                            {activeFilter === "skipped"
                              ? `${skipReasonLabel(code)} · ${count}`
                              : `${code === "Unknown" ? "Unknown" : ERROR_MESSAGES[code] || "Unknown"} (${code}) · ${count}`}
                          </button>
                        ))}
                    </div>
                  )}

                  {/* Split replies by kind — button taps are the real intent signal,
                      auto-replies are the recipient's WhatsApp Business greeting. */}
                  {activeFilter === "replied" && replyTypeBreakdown && (
                    <div className="px-5 py-2.5 border-b border-gray-100 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-gray-400 mr-1">Reply type:</span>
                      <button
                        onClick={() => setReplyTypeFilter(null)}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                          replyTypeFilter === null ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                        }`}
                      >
                        All ({Object.values(replyTypeBreakdown).reduce((a, b) => a + b, 0)})
                      </button>
                      {(Object.keys(REPLY_TYPE_LABELS) as ReplyType[]).map((type) => (
                        <button
                          key={type}
                          onClick={() => setReplyTypeFilter(type)}
                          className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                            replyTypeFilter === type ? REPLY_TYPE_COLORS[type] : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                          }`}
                        >
                          {REPLY_TYPE_LABELS[type]} · {replyTypeBreakdown[type] || 0}
                        </button>
                      ))}
                    </div>
                  )}

                  {msgLoading ? (
                    <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
                  ) : messages.length === 0 ? (
                    <div className="p-8 text-center text-gray-400 text-sm">
                      {activeFilter === "all" ? "No messages found" : `No ${activeFilter} messages found`}
                    </div>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 text-gray-600">
                            <tr>
                              <th className="text-left px-5 py-2 font-medium">Phone</th>
                              <th className="text-left px-5 py-2 font-medium">Name</th>
                              <th className="text-left px-5 py-2 font-medium">Sent From</th>
                              <th className="text-left px-5 py-2 font-medium">Status</th>
                              <th className="text-left px-5 py-2 font-medium">Sent At</th>
                              {campaignEmails && <th className="text-left px-5 py-2 font-medium">Email</th>}
                              {activeFilter === "failed" && <th className="text-left px-5 py-2 font-medium">Error</th>}
                              {(activeFilter === "skipped" || activeFilter === "all") && (
                                <th className="text-left px-5 py-2 font-medium">Reason</th>
                              )}
                              {activeFilter === "replied" && (
                                <>
                                  <th className="text-left px-5 py-2 font-medium">Replied At</th>
                                  <th className="text-left px-5 py-2 font-medium">Reply</th>
                                </>
                              )}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {messages.map((msg, i) => (
                              <tr key={i} className="hover:bg-gray-50">
                                <td className="px-5 py-2 text-gray-900">{msg.phone}</td>
                                <td className="px-5 py-2 text-gray-600">{msg.name || "-"}</td>
                                <td className="px-5 py-2 text-gray-500 text-xs">{msg.sendingNumber || "-"}</td>
                                <td className={`px-5 py-2 font-medium ${msgStatusColors[msg.status] || "text-gray-500"}`}>{msg.status}</td>
                                <td className="px-5 py-2 text-gray-500">{msg.sentAt ? new Date(msg.sentAt).toLocaleTimeString() : "-"}</td>
                                {campaignEmails && (
                                  <td className="px-5 py-2">
                                    {msg.emailStatus ? (
                                      <>
                                        <span className={`font-medium ${emailStatusColors[msg.emailStatus] || "text-gray-500"}`}>
                                          {msg.emailStatus}
                                        </span>
                                        <span className="block text-[11px] text-gray-400 truncate max-w-[200px]" title={msg.email || ""}>
                                          {msg.emailReason || msg.email || ""}
                                        </span>
                                      </>
                                    ) : (
                                      // No row means either no address on the contact or a send
                                      // that predates per-recipient tracking — worth telling
                                      // apart, since the first is a data gap you can fix.
                                      <span className="text-gray-300" title={msg.email ? "No email record for this contact" : "No email address in this contact's CSV row"}>
                                        {msg.email ? "-" : "no address"}
                                      </span>
                                    )}
                                  </td>
                                )}
                                {activeFilter === "failed" && (
                                  <td className="px-5 py-2 text-red-500 text-xs">
                                    {msg.errorCode ? `${ERROR_MESSAGES[msg.errorCode] || "Unknown"} (${msg.errorCode})` : "-"}
                                  </td>
                                )}
                                {(activeFilter === "skipped" || activeFilter === "all") && (
                                  <td className="px-5 py-2 text-gray-500 text-xs">
                                    {msg.status === "skipped"
                                      ? skipReasonLabel(msg.errorCode)
                                      : msg.status === "failed" && msg.errorCode
                                      ? `${ERROR_MESSAGES[msg.errorCode] || "Unknown"} (${msg.errorCode})`
                                      : "-"}
                                  </td>
                                )}
                                {activeFilter === "replied" && (
                                  <>
                                    <td className="px-5 py-2 text-gray-500">{msg.repliedAt ? new Date(msg.repliedAt).toLocaleTimeString() : "-"}</td>
                                    <td className="px-5 py-2 text-xs max-w-[320px]">
                                      {msg.replyType && (
                                        <span className={`font-medium ${REPLY_TYPE_TEXT[msg.replyType]}`}>{REPLY_TYPE_LABELS[msg.replyType]}</span>
                                      )}
                                      <span className="block text-gray-500 truncate" title={msg.replyText || ""}>{msg.replyText || "-"}</span>
                                    </td>
                                  </>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
                          <p className="text-xs text-gray-500">Page {page} of {totalPages}</p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => { const p = page - 1; setPage(p); loadMessages(activeFilter, p, errorCodeFilter); }}
                              disabled={page === 1}
                              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => { const p = page + 1; setPage(p); loadMessages(activeFilter, p, errorCodeFilter); }}
                              disabled={page === totalPages}
                              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

            </div>
          )}
      </AppShell>
    </AuthGuard>
  );
}
