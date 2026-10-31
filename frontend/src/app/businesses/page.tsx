"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { Business } from "@/types";
import { apiRequest } from "@/lib/api";
import { ExternalLink, CheckCircle, XCircle, Loader2, Plus, Pencil } from "lucide-react";

const PROVIDER_BADGE: Record<string, string> = {
  meta: "bg-blue-100 text-blue-700",
  aisensy: "bg-purple-100 text-purple-700",
  wati: "bg-teal-100 text-teal-700",
};

export default function BusinessesPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeBusinessId, setActiveBusinessId] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});
  const [subscribeErrors, setSubscribeErrors] = useState<Record<string, string>>({});
  const [registering, setRegistering] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});
  const [registerErrors, setRegisterErrors] = useState<Record<string, string>>({});
  const [pinInputs, setPinInputs] = useState<Record<string, string>>({});
  const [qualityRatings, setQualityRatings] = useState<
    Record<string, { qualityRating: string; messagingLimit: string; canSendMessage?: string; healthErrors?: { code?: number; description?: string; solution?: string }[] }>
  >({});
  const [checkingQuality, setCheckingQuality] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses")
      .then((data) => {
        setBusinesses(data.businesses);
        setActiveBusinessId((prev) => prev || data.businesses[0]?.businessId || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const activeBusiness = businesses.find((b) => b.businessId === activeBusinessId);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const subscribeWaba = async (businessId: string, wabaid: string) => {
    setSubscribing((prev) => ({ ...prev, [wabaid]: "loading" }));
    try {
      const data = await apiRequest<{ results: { wabaid: string; status: string; error?: string }[] }>(
        "/businesses/subscribe-webhooks",
        { method: "POST", body: JSON.stringify({ businessId, targetWabaid: wabaid }) }
      );
      const result = data.results[0];
      if (result?.status === "subscribed") {
        setSubscribing((prev) => ({ ...prev, [wabaid]: "success" }));
        setToast({ message: `${wabaid} subscribed successfully`, type: "success" });
      } else {
        setSubscribing((prev) => ({ ...prev, [wabaid]: "error" }));
        setSubscribeErrors((prev) => ({ ...prev, [wabaid]: result?.error || "Failed" }));
        setToast({ message: result?.error || "Subscription failed", type: "error" });
      }
    } catch {
      setSubscribing((prev) => ({ ...prev, [wabaid]: "error" }));
      setToast({ message: "Request failed", type: "error" });
    }
  };

  const subscribeAll = async (biz: Business) => {
    const wabaIds = [...new Set(biz.phoneNumbers.map((pn) => pn.wabaid).filter((w): w is string => Boolean(w)))];
    for (const wabaid of wabaIds) {
      await subscribeWaba(biz.businessId, wabaid);
    }
  };

  // Registers a number on the Cloud API — required once per number before it
  // can send/receive messages, separate from (and usually done before)
  // subscribing its WABA to receive status webhooks.
  const registerNumber = async (businessId: string, phoneNumberId: string) => {
    const pin = pinInputs[phoneNumberId] || "030524";
    setRegistering((prev) => ({ ...prev, [phoneNumberId]: "loading" }));
    try {
      await apiRequest("/businesses/register-number", {
        method: "POST",
        body: JSON.stringify({ businessId, phoneNumberId, pin }),
      });
      setRegistering((prev) => ({ ...prev, [phoneNumberId]: "success" }));
      setToast({ message: `${phoneNumberId} registered successfully`, type: "success" });
    } catch (err) {
      setRegistering((prev) => ({ ...prev, [phoneNumberId]: "error" }));
      const msg = err instanceof Error ? err.message : "Registration failed";
      setRegisterErrors((prev) => ({ ...prev, [phoneNumberId]: msg }));
      setToast({ message: msg, type: "error" });
    }
  };

  const checkQuality = async (businessId: string, phoneNumberIds?: string[]) => {
    const ids = phoneNumberIds || [];
    ids.forEach((id) => setCheckingQuality((prev) => ({ ...prev, [id]: true })));
    if (!ids.length) {
      // Check all
      businesses.forEach((biz) => {
        if (biz.businessId === businessId) {
          biz.phoneNumbers.forEach((pn) => setCheckingQuality((prev) => ({ ...prev, [pn.phoneNumberId]: true })));
        }
      });
    }

    try {
      const data = await apiRequest<{
        results: Record<string, { qualityRating: string; messagingLimit: string; canSendMessage?: string; healthErrors?: { code?: number; description?: string; solution?: string }[] }>;
      }>(
        "/businesses/quality-check",
        { method: "POST", body: JSON.stringify({ businessId, phoneNumberIds: ids.length ? ids : undefined }) }
      );
      setQualityRatings((prev) => ({ ...prev, ...data.results }));
    } catch {
      setToast({ message: "Quality check failed", type: "error" });
    } finally {
      ids.forEach((id) => setCheckingQuality((prev) => ({ ...prev, [id]: false })));
      if (!ids.length) {
        businesses.forEach((biz) => {
          if (biz.businessId === businessId) {
            biz.phoneNumbers.forEach((pn) => setCheckingQuality((prev) => ({ ...prev, [pn.phoneNumberId]: false })));
          }
        });
      }
    }
  };

  return (
    <AuthGuard>
    <AppShell>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Businesses</h2>
          <Link
            href="/businesses/new"
            className="flex items-center gap-1.5 text-sm bg-primary-600 text-white px-3 py-1.5 rounded-lg hover:bg-primary-700 font-medium"
          >
            <Plus className="w-4 h-4" />
            Add Business
          </Link>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : businesses.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <p className="text-gray-500">No businesses configured yet.</p>
          </div>
        ) : (
          <>
            {/* Business tabs */}
            <div className="flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
              {businesses.map((biz) => {
                const provider = biz.provider || "meta";
                const active = biz.businessId === activeBusinessId;
                return (
                  <button
                    key={biz.businessId}
                    onClick={() => setActiveBusinessId(biz.businessId)}
                    className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
                      active
                        ? "border-primary-600 text-primary-700"
                        : "border-transparent text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {biz.businessName}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase ${PROVIDER_BADGE[provider] || PROVIDER_BADGE.meta}`}>
                      {provider}
                    </span>
                    <span className="text-xs text-gray-400">({biz.phoneNumbers.length})</span>
                  </button>
                );
              })}
            </div>

            {activeBusiness && (() => {
              const biz = activeBusiness;
              const provider = biz.provider || "meta";
              return (
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-center justify-end mb-4">
                  <div className="flex gap-2">
                    {provider === "meta" && (
                      <>
                        <button
                          onClick={() => checkQuality(biz.businessId)}
                          className="text-xs bg-green-50 text-green-700 px-3 py-1.5 rounded-lg hover:bg-green-100 font-medium"
                        >
                          Check All Quality
                        </button>
                        <button
                          onClick={() => subscribeAll(biz)}
                          className="text-xs bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-100 font-medium"
                        >
                          Subscribe All WABAs
                        </button>
                      </>
                    )}
                    <Link
                      href={`/businesses/new?businessId=${biz.businessId}`}
                      className="flex items-center gap-1 text-xs bg-gray-50 text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-100 font-medium"
                    >
                      <Pencil className="w-3 h-3" />
                      Edit
                    </Link>
                  </div>
                </div>

                <div className="overflow-x-auto overflow-y-auto max-h-[65vh]">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium">Name</th>
                        <th className="text-left px-4 py-2 font-medium">Number</th>
                        <th className="text-left px-4 py-2 font-medium">Number ID</th>
                        {provider === "meta" ? (
                          <>
                            <th className="text-left px-4 py-2 font-medium">Quality</th>
                            <th className="text-left px-4 py-2 font-medium">Health</th>
                            <th className="text-left px-4 py-2 font-medium">WABA ID</th>
                            <th className="text-left px-4 py-2 font-medium">Register</th>
                            <th className="text-left px-4 py-2 font-medium">Webhook</th>
                            <th className="text-left px-4 py-2 font-medium">Links</th>
                          </>
                        ) : (
                          <th className="text-left px-4 py-2 font-medium">API Key</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {biz.phoneNumbers.map((pn) => (
                        <tr key={pn.phoneNumberId} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-900">{pn.displayName}</td>
                          <td className="px-4 py-3 text-gray-600">{pn.displayNumber}</td>
                          <td className="px-4 py-3 text-gray-400 font-mono text-xs">{pn.phoneNumberId}</td>
                          {provider === "meta" ? (
                            <>
                              <td className="px-4 py-3">
                                {checkingQuality[pn.phoneNumberId] ? (
                                  <span className="text-xs text-gray-400">Checking...</span>
                                ) : qualityRatings[pn.phoneNumberId] ? (
                                  (() => {
                                    const rating = qualityRatings[pn.phoneNumberId].qualityRating;
                                    const colors: Record<string, string> = {
                                      GREEN: "bg-green-100 text-green-700",
                                      YELLOW: "bg-yellow-100 text-yellow-700",
                                      RED: "bg-red-100 text-red-700",
                                      UNKNOWN: "bg-gray-100 text-gray-500",
                                    };
                                    return (
                                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[rating] || colors.UNKNOWN}`}>
                                        {rating}
                                      </span>
                                    );
                                  })()
                                ) : (
                                  <button
                                    onClick={() => checkQuality(biz.businessId, [pn.phoneNumberId])}
                                    className="text-xs text-green-600 hover:text-green-700 font-medium"
                                  >
                                    Check
                                  </button>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {checkingQuality[pn.phoneNumberId] ? (
                                  <span className="text-xs text-gray-400">Checking...</span>
                                ) : qualityRatings[pn.phoneNumberId] ? (
                                  (() => {
                                    const q = qualityRatings[pn.phoneNumberId];
                                    const canSend = q.canSendMessage || "UNKNOWN";
                                    const colors: Record<string, string> = {
                                      AVAILABLE: "bg-green-100 text-green-700",
                                      LIMITED: "bg-yellow-100 text-yellow-700",
                                      BLOCKED: "bg-red-100 text-red-700",
                                      UNKNOWN: "bg-gray-100 text-gray-500",
                                    };
                                    const firstError = q.healthErrors?.[0];
                                    return (
                                      <div>
                                        <span
                                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[canSend] || colors.UNKNOWN}`}
                                          title={firstError?.description}
                                        >
                                          {canSend}
                                        </span>
                                        {firstError?.description && (
                                          <p className="text-[10px] text-red-600 mt-0.5 max-w-[220px]">{firstError.description}</p>
                                        )}
                                      </div>
                                    );
                                  })()
                                ) : (
                                  <span className="text-xs text-gray-400">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-gray-400 text-xs font-mono">{pn.wabaid}</td>
                              <td className="px-4 py-3">
                                {registering[pn.phoneNumberId] === "loading" ? (
                                  <span className="flex items-center gap-1 text-xs text-blue-600">
                                    <Loader2 className="w-3 h-3 animate-spin" /> Registering...
                                  </span>
                                ) : registering[pn.phoneNumberId] === "success" ? (
                                  <span className="flex items-center gap-1 text-xs text-green-600">
                                    <CheckCircle className="w-3 h-3" /> Registered
                                  </span>
                                ) : (
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="text"
                                      value={pinInputs[pn.phoneNumberId] ?? "030524"}
                                      onChange={(e) =>
                                        setPinInputs((prev) => ({ ...prev, [pn.phoneNumberId]: e.target.value }))
                                      }
                                      className="w-16 border border-gray-300 rounded px-1.5 py-0.5 text-xs"
                                      placeholder="PIN"
                                    />
                                    <button
                                      onClick={() => registerNumber(biz.businessId, pn.phoneNumberId)}
                                      className="text-xs text-green-600 hover:text-green-700 font-medium"
                                    >
                                      Register
                                    </button>
                                    {registering[pn.phoneNumberId] === "error" && (
                                      <span className="text-xs text-red-600" title={registerErrors[pn.phoneNumberId]}>
                                        Failed
                                      </span>
                                    )}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {subscribing[pn.wabaid || ""] === "loading" ? (
                                  <span className="flex items-center gap-1 text-xs text-blue-600">
                                    <Loader2 className="w-3 h-3 animate-spin" /> Subscribing...
                                  </span>
                                ) : subscribing[pn.wabaid || ""] === "success" ? (
                                  <span className="flex items-center gap-1 text-xs text-green-600">
                                    <CheckCircle className="w-3 h-3" /> Subscribed
                                  </span>
                                ) : subscribing[pn.wabaid || ""] === "error" ? (
                                  <span className="flex items-center gap-1 text-xs text-red-600">
                                    <XCircle className="w-3 h-3" /> {subscribeErrors[pn.wabaid || ""] || "Failed"}
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => pn.wabaid && subscribeWaba(biz.businessId, pn.wabaid)}
                                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                                  >
                                    Subscribe
                                  </button>
                                )}
                              </td>
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
                            </>
                          ) : (
                            <td className="px-4 py-3 text-gray-400 text-xs">
                              <CheckCircle className="w-3 h-3 inline text-green-500 mr-1" />
                              Configured
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              );
            })()}
          </>
        )}

        {/* Toast notification */}
        {toast && (
          <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg text-sm font-medium z-50 ${
            toast.type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white"
          }`}>
            {toast.message}
          </div>
        )}
    </AppShell>
    </AuthGuard>
  );
}
