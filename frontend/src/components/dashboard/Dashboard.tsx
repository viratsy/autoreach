"use client";

import { useEffect, useState, useCallback } from "react";
import { DashboardStats, Campaign, Business } from "@/types";
import { apiRequest } from "@/lib/api";
import StatsCards from "./StatsCards";
import RecentCampaigns from "./RecentCampaigns";
import {
  AlertTriangle,
  ExternalLink,
  X,
  ChevronDown,
  ChevronUp,
  Phone,
  RefreshCw,
  Building2,
} from "lucide-react";

interface Notification {
  id: string;
  SK: string;
  type: string;
  businessId: string;
  businessName: string;
  phoneDisplayName: string;
  templateName: string;
  errorMessage: string;
  campaignId: string;
  appealLink: string;
  businessManagerLink: string;
  createdAt: string;
  occurrenceCount?: number;
}

interface QualityResult {
  qualityRating: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
  messagingLimit: string;
  status: string;
}

interface BusinessHealth {
  [phoneNumberId: string]: QualityResult;
}

type HealthState = "loading" | "loaded" | "error" | "idle";

interface NotifGroup {
  key: string;
  errorMessage: string;
  type: string;
  businessId: string;
  businessName: string;
  templateName: string;
  appealLink: string;
  businessManagerLink: string;
  items: Notification[];
}

function groupNotifications(notifs: Notification[]): NotifGroup[] {
  const map = new Map<string, NotifGroup>();
  for (const n of notifs) {
    const key = `${n.type}::${n.businessId}::${n.errorMessage.slice(0, 80)}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        errorMessage: n.errorMessage,
        type: n.type,
        businessId: n.businessId,
        businessName: n.businessName,
        templateName: n.templateName,
        appealLink: n.appealLink,
        businessManagerLink: n.businessManagerLink,
        items: [],
      });
    }
    map.get(key)!.items.push(n);
  }
  return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length);
}

function HealthBadge({ rating }: { rating: QualityResult["qualityRating"] }) {
  const map = {
    GREEN: { label: "Healthy", cls: "bg-emerald-100 text-emerald-700" },
    YELLOW: { label: "Warning", cls: "bg-amber-100 text-amber-700" },
    RED: { label: "At Risk", cls: "bg-red-100 text-red-700" },
    UNKNOWN: { label: "Unknown", cls: "bg-gray-100 text-gray-500" },
  };
  const { label, cls } = map[rating] ?? map.UNKNOWN;
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

function healthSummary(health: BusinessHealth, total: number): string {
  if (total === 0) return "No numbers";
  const counts = { GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 };
  for (const r of Object.values(health)) {
    counts[r.qualityRating] = (counts[r.qualityRating] || 0) + 1;
  }
  const parts: string[] = [];
  if (counts.GREEN) parts.push(`${counts.GREEN} healthy`);
  if (counts.YELLOW) parts.push(`${counts.YELLOW} warning`);
  if (counts.RED) parts.push(`${counts.RED} at risk`);
  const known = counts.GREEN + counts.YELLOW + counts.RED;
  if (known < total) parts.push(`${total - known} unknown`);
  return parts.join(" / ");
}

function BusinessCapsule({ business }: { business: Business }) {
  const isMeta = !business.provider || business.provider === "meta";
  const [health, setHealth] = useState<BusinessHealth>({});
  const [healthState, setHealthState] = useState<HealthState>("idle");
  const [expanded, setExpanded] = useState(false);

  const fetchHealth = useCallback(async () => {
    if (!business.phoneNumbers.length || !isMeta) return;
    setHealthState("loading");
    try {
      const result = await apiRequest<{ results: BusinessHealth }>(
        "/businesses/quality-check",
        {
          method: "POST",
          body: JSON.stringify({
            businessId: business.businessId,
            phoneNumberIds: business.phoneNumbers.map((p) => p.phoneNumberId),
          }),
        }
      );
      setHealth(result.results || {});
      setHealthState("loaded");
    } catch {
      setHealthState("error");
    }
  }, [business, isMeta]);

  // Auto-load health on mount instead of requiring a manual click — only meaningful for
  // Meta numbers, since AiSensy/WATI have no equivalent quality-rating concept.
  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  const totalNums = business.phoneNumbers.length;
  const summary = !isMeta
    ? null
    : healthState === "loaded"
    ? healthSummary(health, totalNums)
    : healthState === "loading"
    ? "Checking..."
    : healthState === "error"
    ? "Check failed"
    : null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate flex items-center gap-1.5">
              {business.businessName}
              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium uppercase bg-gray-100 text-gray-500">
                {business.provider || "meta"}
              </span>
            </p>
            <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
              <Phone className="w-3 h-3" />
              {totalNums} number{totalNums !== 1 ? "s" : ""}
              {summary && (
                <>
                  <span className="text-gray-300">·</span>
                  <span className={healthState === "error" ? "text-red-500" : healthState === "loaded" ? "text-gray-500" : "text-gray-400"}>
                    {summary}
                  </span>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isMeta && (
            <button
              onClick={fetchHealth}
              disabled={healthState === "loading"}
              title="Refresh health"
              className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${healthState === "loading" ? "animate-spin" : ""}`} />
            </button>
          )}
          {totalNums > 0 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* expanded phone list */}
      {expanded && totalNums > 0 && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {business.phoneNumbers.map((pn) => {
            const q = health[pn.phoneNumberId];
            return (
              <div key={pn.phoneNumberId} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="text-xs font-medium text-gray-800">{pn.displayName}</p>
                  <p className="text-[11px] text-gray-400">{pn.displayNumber}</p>
                </div>
                {q ? (
                  <div className="flex items-center gap-2">
                    <HealthBadge rating={q.qualityRating} />
                    <span className="text-[10px] text-gray-400">{q.messagingLimit}</span>
                  </div>
                ) : healthState === "loading" ? (
                  <span className="text-[10px] text-gray-400 animate-pulse">…</span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NotificationsPanel({
  notifications,
  onDismissGroup,
}: {
  notifications: Notification[];
  onDismissGroup: (items: Notification[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = groupNotifications(notifications);
  const total = notifications.length;

  if (total === 0) return null;

  return (
    <div className="border border-amber-200 rounded-xl overflow-hidden bg-amber-50">
      {/* toggle bar */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-amber-100/60 transition"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-amber-800">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          Action Required
          <span className="ml-1 bg-amber-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none">
            {total}
          </span>
          <span className="text-amber-600 font-normal text-xs ml-1">
            ({groups.length} issue{groups.length !== 1 ? "s" : ""})
          </span>
        </span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-amber-600" />
        ) : (
          <ChevronDown className="w-4 h-4 text-amber-600" />
        )}
      </button>

      {open && (
        <div className="border-t border-amber-200 divide-y divide-amber-100">
          {groups.map((g) => (
            <div key={g.key} className="px-4 py-3 flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase ${
                      g.type === "template_marketing"
                        ? "bg-orange-100 text-orange-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {g.type === "template_marketing"
                      ? "MARKETING"
                      : g.type === "send_failed"
                      ? "SEND FAILED"
                      : g.type.replace("_", " ")}
                  </span>
                  {(() => {
                    const total = g.items.reduce((sum, n) => sum + (n.occurrenceCount || 1), 0);
                    return total > 1 ? (
                      <span className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-semibold">
                        ×{total}
                      </span>
                    ) : null;
                  })()}
                  <span className="text-xs text-gray-500">{g.businessName}</span>
                  {g.templateName && (
                    <span className="text-xs text-gray-400">· {g.templateName}</span>
                  )}
                </div>
                <p className="text-sm text-gray-900">{g.errorMessage}</p>
                <div className="flex items-center gap-3 mt-1.5">
                  {g.businessManagerLink && (
                    <a
                      href={g.businessManagerLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <ExternalLink className="w-3 h-3" /> Business Manager
                    </a>
                  )}
                  {g.appealLink && (
                    <a
                      href={g.appealLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-700 font-medium"
                    >
                      <ExternalLink className="w-3 h-3" /> Templates
                    </a>
                  )}
                </div>
              </div>
              <button
                onClick={() => onDismissGroup(g.items)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-white text-gray-700 rounded-lg hover:bg-gray-100 border border-gray-200 shrink-0 mt-0.5"
              >
                <X className="w-3 h-3" />
                {g.items.length > 1 ? `Dismiss ${g.items.length}` : "Dismiss"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    totalCampaigns: 0,
    scheduled: 0,
    running: 0,
    completed: 0,
    failed: 0,
  });
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [bizLoading, setBizLoading] = useState(true);

  useEffect(() => {
    apiRequest<{ campaigns: Campaign[]; stats: DashboardStats }>("/campaigns")
      .then((data) => {
        setCampaigns(data.campaigns);
        setStats(data.stats);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    apiRequest<{ notifications: Notification[] }>("/notifications")
      .then((data) => setNotifications(data.notifications || []))
      .catch(() => {});

    apiRequest<{ businesses: Business[] }>("/businesses")
      .then((data) => setBusinesses(data.businesses || []))
      .catch(() => {})
      .finally(() => setBizLoading(false));
  }, []);

  const dismissGroup = async (items: Notification[]) => {
    await Promise.allSettled(
      items.map((n) =>
        apiRequest(`/notifications?id=${n.id}&sk=${encodeURIComponent(n.SK)}`, { method: "DELETE" })
      )
    );
    const ids = new Set(items.map((n) => n.SK));
    setNotifications((prev) => prev.filter((n) => !ids.has(n.SK)));
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
        <p className="text-gray-500 text-sm mt-1">Campaign overview and metrics</p>
      </div>

      <NotificationsPanel notifications={notifications} onDismissGroup={dismissGroup} />

      {/* Business capsules */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Connected Businesses</h3>
        {bizLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : businesses.length === 0 ? (
          <p className="text-sm text-gray-400">No businesses connected yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {businesses.map((b) => (
              <BusinessCapsule key={b.businessId} business={b} />
            ))}
          </div>
        )}
      </div>

      <StatsCards stats={stats} />

      {loading ? (
        <p className="text-gray-400 text-sm text-center py-8">Loading campaigns...</p>
      ) : (
        <RecentCampaigns campaigns={campaigns.slice(0, 10)} />
      )}
    </div>
  );
}
