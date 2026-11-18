"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Copy, CheckCircle, XCircle, RefreshCw, ExternalLink, Plus, Trash2, Eye, X } from "lucide-react";
import TemplatePreview from "@/components/campaign/TemplatePreview";
import { TemplateComponent } from "@/types";
import ImagePicker from "@/components/campaign/ImagePicker";
import { Provider } from "@/types";

interface Business {
  businessId: string;
  businessName: string;
  provider?: Provider;
  phoneNumbers: { phoneNumberId: string; displayName: string; displayNumber: string; wabaid?: string }[];
}

interface TemplateInfo {
  templateName: string;
  category: string;
  parameterCount: number;
  availableOn: string[];
  categoryPerNumber?: Record<string, string>;
  hasImageHeaderPerNumber?: Record<string, boolean>;
  statusPerNumber?: Record<string, string>;
  components?: TemplateComponent[];
  lastSyncedAt?: string;
}

const PAGE_SIZE = 20;

function formatSyncedAt(iso?: string) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "never";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
}

// Sample values Meta stored with the template ({{1}} -> "Priya", ...) and the
// header image it was approved with, so a preview reads like a real message
// instead of a row of blanks.
function previewInputs(components: TemplateComponent[] = []) {
  const find = (type: string) =>
    components.find((c) => String(c.type).toUpperCase() === type) as
      | (TemplateComponent & { example?: { body_text?: string[][]; header_handle?: string[] } })
      | undefined;
  const values: Record<string, string> = {};
  (find("BODY")?.example?.body_text?.[0] || []).forEach((v, i) => {
    values[String(i + 1)] = v;
  });
  const header = find("HEADER");
  const headerImageUrl =
    String(header?.format || "").toUpperCase() === "IMAGE" ? header?.example?.header_handle?.[0] : undefined;
  return { values, headerImageUrl };
}

export default function TemplatesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-gray-400">Loading...</p></div>}>
      <TemplatesContent />
    </Suspense>
  );
}

function TemplatesContent() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBiz, setSelectedBiz] = useState<Business | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingTemplate, setSyncingTemplate] = useState<string | null>(null);
  const [syncingNumber, setSyncingNumber] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"ALL" | "UTILITY" | "MARKETING">("ALL");
  // Only PAGE_SIZE cards render at first (each carries a chip per number and
  // a preview) — "Show more" adds the next page. Resets when the list changes.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => setVisibleCount(PAGE_SIZE), [search, categoryFilter, selectedBiz]);
  // Last single-template "Sync with Meta" outcome, shown on that card.
  const [syncResult, setSyncResult] = useState<Record<string, string>>({});

  // Copy state
  const [copyTemplate, setCopyTemplate] = useState<TemplateInfo | null>(null);
  const [sourceNumber, setSourceNumber] = useState("");
  const [copyTargetBusinessId, setCopyTargetBusinessId] = useState("");
  const [targetWabas, setTargetWabas] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  const [copyResults, setCopyResults] = useState<{ wabaid: string; status: string; error?: string }[]>([]);
  const [headerImageUrl, setHeaderImageUrl] = useState("");

  // Per-number preview (eye icon on a number chip)
  const [preview, setPreview] = useState<{
    key: string;
    templateName: string;
    number: { displayName: string; displayNumber: string };
    loading: boolean;
    error?: string;
    data?: { category?: string; status?: string; components: TemplateComponent[] };
  } | null>(null);
  const openNumberPreview = async (
    templateName: string,
    pn: { phoneNumberId: string; displayName: string; displayNumber: string }
  ) => {
    if (!selectedBiz) return;
    const key = `${pn.phoneNumberId}#${templateName}`;
    setPreview({ key, templateName, number: pn, loading: true });
    try {
      const d = await apiRequest<{ template: { category?: string; status?: string; components: TemplateComponent[] } }>(
        `/templates?businessId=${selectedBiz.businessId}&phoneNumberId=${pn.phoneNumberId}&templateName=${encodeURIComponent(templateName)}`
      );
      setPreview((p) => (p && p.key === key ? { ...p, loading: false, data: d.template } : p));
    } catch {
      setPreview((p) => (p && p.key === key ? { ...p, loading: false, error: "Couldn't load this number's template" } : p));
    }
  };

  // Create template (Meta) state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [newLanguage, setNewLanguage] = useState("en_US");
  const [newBody, setNewBody] = useState("");
  const [newBodyExamples, setNewBodyExamples] = useState<Record<string, string>>({});
  const [newHeaderText, setNewHeaderText] = useState("");
  const [newHeaderImageUrl, setNewHeaderImageUrl] = useState("");
  const [newFooter, setNewFooter] = useState("");
  const [newButtons, setNewButtons] = useState<{ type: "QUICK_REPLY" | "PHONE_NUMBER" | "URL"; text: string; phoneNumber?: string; url?: string }[]>([]);
  const [newTargets, setNewTargets] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createResults, setCreateResults] = useState<{ phoneNumberId: string; displayName: string; status: string; error?: string }[]>([]);

  // Manual add (AiSensy) state
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualParamCount, setManualParamCount] = useState("0");
  const [addingManual, setAddingManual] = useState(false);

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses").then((d) => {
      setBusinesses(d.businesses);
      if (d.businesses.length > 0) {
        setSelectedBiz(d.businesses[0]);
      }
    });
  }, []);

  useEffect(() => {
    if (selectedBiz) loadTemplates();
  }, [selectedBiz]);

  const loadTemplates = async () => {
    if (!selectedBiz) return;
    setLoading(true);
    try {
      const phoneIds = selectedBiz.phoneNumbers.map((p) => p.phoneNumberId).join(",");
      const data = await apiRequest<{ templates: TemplateInfo[] }>(
        `/templates?businessId=${selectedBiz.businessId}&phoneNumberIds=${phoneIds}`
      );
      setTemplates(data.templates);
    } catch {} finally { setLoading(false); }
  };

  const syncTemplates = async () => {
    if (!selectedBiz) return;
    setSyncing(true);
    try {
      await apiRequest("/templates/fetch", {
        method: "POST",
        body: JSON.stringify({ businessId: selectedBiz.businessId }),
      });
      await loadTemplates();
    } catch {} finally { setSyncing(false); }
  };

  // Deletes every stored template row for this business first, then re-fetches
  // from scratch — unlike syncTemplates (an upsert), this also clears rows for
  // templates Meta no longer returns at all (deleted/renamed on Meta's side).
  const clearAndResync = async () => {
    if (!selectedBiz) return;
    setClearing(true);
    setShowClearConfirm(false);
    try {
      await apiRequest("/templates/fetch", {
        method: "POST",
        body: JSON.stringify({ businessId: selectedBiz.businessId, clearFirst: true }),
      });
      await loadTemplates();
    } catch {} finally { setClearing(false); }
  };

  // Re-syncs just one template (across every number) instead of the whole
  // catalog — for refreshing a single row that looks stale without waiting
  // on a full re-fetch of everything else too.
  const syncOneTemplate = async (templateName: string) => {
    if (!selectedBiz) return;
    setSyncingTemplate(templateName);
    try {
      const r = await apiRequest<{ templates: Record<string, string[]>; removedOn?: string[]; failedOn?: string[] }>(
        "/templates/fetch",
        {
          method: "POST",
          body: JSON.stringify({ businessId: selectedBiz.businessId, templateName }),
        }
      );
      const found = Object.values(r.templates || {}).filter((names) => names.includes(templateName)).length;
      const parts = [`On ${found} number${found === 1 ? "" : "s"}`];
      if (r.removedOn?.length) parts.push(`${r.removedOn.length} no longer have it`);
      if (r.failedOn?.length) parts.push(`${r.failedOn.length} couldn't be checked`);
      setSyncResult((s) => ({ ...s, [templateName]: parts.join(" · ") }));
      await loadTemplates();
    } catch {
      setSyncResult((s) => ({ ...s, [templateName]: "Sync failed — try again" }));
    } finally { setSyncingTemplate(null); }
  };

  // Re-syncs just one phone number (a single Meta call for its WABA) instead
  // of fanning out to every number at once — isolates whether a number's
  // sync issue is a real absence of templates on Meta's side, versus an
  // artifact of the full sync's concurrent fan-out.
  const syncOneNumber = async (phoneNumberId: string) => {
    if (!selectedBiz) return;
    setSyncingNumber(phoneNumberId);
    try {
      await apiRequest("/templates/fetch", {
        method: "POST",
        body: JSON.stringify({ businessId: selectedBiz.businessId, phoneNumberId }),
      });
      await loadTemplates();
    } catch {} finally { setSyncingNumber(null); }
  };

  const handleCopy = async () => {
    if (!selectedBiz || !copyTemplate || !sourceNumber || targetWabas.length === 0) return;
    setCopying(true);
    setCopyResults([]);
    try {
      const data = await apiRequest<{ results: { wabaid: string; status: string; error?: string }[] }>(
        "/templates/copy",
        {
          method: "POST",
          body: JSON.stringify({
            businessId: selectedBiz.businessId,
            sourcePhoneNumberId: sourceNumber,
            templateName: copyTemplate.templateName,
            targetWabaIds: targetWabas,
            targetBusinessId: copyTargetBusinessId && copyTargetBusinessId !== selectedBiz.businessId ? copyTargetBusinessId : undefined,
            headerImageUrl: headerImageUrl || undefined,
          }),
        }
      );
      setCopyResults(data.results);
    } catch (err) {
      setCopyResults([{ wabaid: "all", status: "failed", error: "Request failed" }]);
    } finally { setCopying(false); }
  };

  const toggleTargetWaba = (wabaid: string) => {
    setTargetWabas((prev) =>
      prev.includes(wabaid) ? prev.filter((w) => w !== wabaid) : [...prev, wabaid]
    );
  };

  const toggleNewTarget = (phoneNumberId: string) => {
    setNewTargets((prev) =>
      prev.includes(phoneNumberId) ? prev.filter((id) => id !== phoneNumberId) : [...prev, phoneNumberId]
    );
  };

  const resetCreateForm = () => {
    setNewName("");
    setNewCategory("UTILITY");
    setNewLanguage("en_US");
    setNewBody("");
    setNewBodyExamples({});
    setNewHeaderText("");
    setNewHeaderImageUrl("");
    setNewFooter("");
    setNewButtons([]);
    setNewTargets([]);
    setCreateResults([]);
  };

  const addNewButton = () => {
    if (newButtons.length >= 3) return; // matches Meta's 3-button no-"see all" limit
    setNewButtons((prev) => [...prev, { type: "QUICK_REPLY", text: "" }]);
  };
  const updateNewButton = (i: number, updates: Partial<(typeof newButtons)[number]>) => {
    setNewButtons((prev) => prev.map((b, bi) => (bi === i ? { ...b, ...updates } : b)));
  };
  const removeNewButton = (i: number) => {
    setNewButtons((prev) => prev.filter((_, bi) => bi !== i));
  };

  // Variable numbers referenced in the body text, in ascending order — drives
  // the per-variable example-value inputs Meta requires for template approval.
  const newBodyParamNumbers = Array.from(
    new Set(Array.from(newBody.matchAll(/\{\{(\d+)\}\}/g)).map((m) => m[1]))
  ).sort((a, b) => Number(a) - Number(b));

  const handleCreateTemplate = async () => {
    if (!selectedBiz || !newName.trim() || !newBody.trim() || newTargets.length === 0) return;
    setCreating(true);
    setCreateResults([]);
    try {
      const data = await apiRequest<{ results: typeof createResults }>("/templates/create", {
        method: "POST",
        body: JSON.stringify({
          businessId: selectedBiz.businessId,
          templateName: newName.trim(),
          category: newCategory,
          language: newLanguage,
          bodyText: newBody,
          bodyExamples: newBodyParamNumbers.map((n) => newBodyExamples[n]?.trim() || `Example${n}`),
          headerText: newHeaderImageUrl ? undefined : newHeaderText || undefined,
          headerImageUrl: newHeaderImageUrl || undefined,
          footerText: newFooter || undefined,
          buttons: newButtons.length > 0 ? newButtons : undefined,
          targetPhoneNumberIds: newTargets,
        }),
      });
      setCreateResults(data.results);
      await loadTemplates();
    } catch (err) {
      setCreateResults([{ phoneNumberId: "all", displayName: "all", status: "failed", error: err instanceof Error ? err.message : "Request failed" }]);
    } finally {
      setCreating(false);
    }
  };

  const handleAddManualTemplate = async () => {
    if (!selectedBiz || !manualName.trim()) return;
    setAddingManual(true);
    try {
      await Promise.all(
        selectedBiz.phoneNumbers.map((pn) =>
          apiRequest("/templates/manual", {
            method: "POST",
            body: JSON.stringify({
              businessId: selectedBiz.businessId,
              phoneNumberId: pn.phoneNumberId,
              templateName: manualName.trim(),
              parameterCount: parseInt(manualParamCount) || 0,
            }),
          })
        )
      );
      setManualName("");
      setManualParamCount("0");
      setShowManualAdd(false);
      await loadTemplates();
    } catch (err) {
      console.error("Manual add failed:", err);
    } finally {
      setAddingManual(false);
    }
  };

  const filtered = templates
    .filter((t) => t.templateName.toLowerCase().includes(search.toLowerCase()))
    .filter((t) => categoryFilter === "ALL" || t.category === categoryFilter);

  const getNumberName = (phoneNumberId: string) =>
    selectedBiz?.phoneNumbers.find((p) => p.phoneNumberId === phoneNumberId)?.displayName || phoneNumberId;

  const getNumberByWaba = (wabaid: string) =>
    businesses.flatMap((b) => b.phoneNumbers).find((p) => p.wabaid === wabaid);

  return (
    <AuthGuard>
      <AppShell>
          <div className="max-w-5xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-gray-900">Templates</h2>
              <div className="flex items-center gap-3">
                {(selectedBiz?.provider || "meta") === "meta" && (
                  <button
                    onClick={() => { resetCreateForm(); setShowCreate(true); }}
                    className="flex items-center gap-1 text-sm bg-primary-600 text-white px-3 py-1.5 rounded-lg hover:bg-primary-700 font-medium"
                  >
                    <Plus className="w-4 h-4" />
                    Create Template
                  </button>
                )}
                {selectedBiz?.provider === "aisensy" && (
                  <button
                    onClick={() => setShowManualAdd(true)}
                    className="flex items-center gap-1 text-sm bg-primary-600 text-white px-3 py-1.5 rounded-lg hover:bg-primary-700 font-medium"
                  >
                    <Plus className="w-4 h-4" />
                    Add Template Manually
                  </button>
                )}
                {(selectedBiz?.provider || "meta") !== "aisensy" && (
                  <button
                    onClick={syncTemplates}
                    disabled={syncing || clearing}
                    className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
                    {syncing ? "Syncing..." : selectedBiz?.provider === "wati" ? "Sync from WATI" : "Sync from Meta"}
                  </button>
                )}
                {(selectedBiz?.provider || "meta") !== "aisensy" && (
                  <div className="relative">
                    <button
                      onClick={() => setShowClearConfirm((v) => !v)}
                      disabled={syncing || clearing}
                      title="Delete all stored templates for this business, then re-fetch from scratch"
                      className="flex items-center gap-1 text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
                    >
                      <Trash2 className={`w-4 h-4 ${clearing ? "animate-pulse" : ""}`} />
                      {clearing ? "Clearing & resyncing..." : "Clear & Resync"}
                    </button>
                    {showClearConfirm && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowClearConfirm(false)} />
                        <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-20 p-3 text-sm">
                          <p className="text-gray-700 mb-3">
                            This deletes every stored template for <span className="font-medium">{selectedBiz?.businessName}</span> and
                            re-fetches fresh from {selectedBiz?.provider === "wati" ? "WATI" : "Meta"}. Useful for clearing stale
                            templates Meta no longer returns. This can&apos;t be undone.
                          </p>
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setShowClearConfirm(false)} className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1">
                              Cancel
                            </button>
                            <button
                              onClick={clearAndResync}
                              className="text-xs bg-red-600 hover:bg-red-700 text-white font-medium px-3 py-1.5 rounded-md"
                            >
                              Yes, clear & resync
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Business selector */}
            {businesses.length > 1 && (
              <div className="mb-4 flex items-center gap-3">
                <select
                  value={selectedBiz?.businessId || ""}
                  onChange={(e) => setSelectedBiz(businesses.find((b) => b.businessId === e.target.value) || null)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  {businesses.map((b) => (
                    <option key={b.businessId} value={b.businessId}>{b.businessName}</option>
                  ))}
                </select>
                <a
                  href={`https://business.facebook.com/wa/manage/message-templates/?business_id=${selectedBiz?.businessId || ""}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
                >
                  <ExternalLink className="w-3 h-3" /> Business Manager
                </a>
              </div>
            )}

            {/* Search + Filter */}
            <div className="flex items-center gap-3 mb-4">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search templates..."
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <div className="flex bg-white border border-gray-200 rounded-lg p-0.5">
                {(["ALL", "UTILITY", "MARKETING"] as const).map((cat) => (
                  <button key={cat} onClick={() => setCategoryFilter(cat)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${categoryFilter === cat ? (cat === "UTILITY" ? "bg-green-600 text-white" : cat === "MARKETING" ? "bg-orange-500 text-white" : "bg-gray-900 text-white") : "text-gray-500 hover:text-gray-700"}`}>
                    {cat === "ALL" ? "All" : cat === "UTILITY" ? "Utility" : "Marketing"}
                  </button>
                ))}
              </div>
            </div>

            {/* Template list */}
            {loading ? (
              <p className="text-gray-500 text-sm">Loading...</p>
            ) : (
              <div className="space-y-2">
                {filtered.slice(0, visibleCount).map((tpl) => (
                  <div key={tpl.templateName} className={`bg-white rounded-lg border p-4 ${tpl.category === "MARKETING" ? "border-orange-200" : "border-gray-200"}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-gray-900 text-sm">{tpl.templateName}</p>
                          {Object.values(tpl.hasImageHeaderPerNumber || {}).some(Boolean) && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded font-medium">🖼 IMG</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500">
                          {(() => {
                            const cats = Object.values(tpl.categoryPerNumber || {});
                            const utilCount = cats.filter(c => c === "UTILITY").length;
                            const mktCount = cats.filter(c => c === "MARKETING").length;
                            return (<>
                              {utilCount > 0 && <span className="font-semibold text-green-600">{utilCount} Utility</span>}
                              {utilCount > 0 && mktCount > 0 && " • "}
                              {mktCount > 0 && <span className="font-semibold text-orange-600">{mktCount} Marketing</span>}
                            </>);
                          })()}
                          {" "}• {tpl.parameterCount} params • on {tpl.availableOn.length}/{selectedBiz?.phoneNumbers.length || 0} numbers
                        </p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {selectedBiz?.phoneNumbers.map((pn) => {
                            const isAvailable = tpl.availableOn.includes(pn.phoneNumberId);
                            const numCategory = tpl.categoryPerNumber?.[pn.phoneNumberId];
                            const numStatus = tpl.statusPerNumber?.[pn.phoneNumberId];
                            const isPending = numStatus === "pending" || numStatus === "PENDING";
                            const isRejected = numStatus === "rejected" || numStatus === "REJECTED";
                            return (
                            <span
                              key={pn.phoneNumberId}
                              className={`group relative text-xs px-1.5 py-0.5 rounded ${
                                isRejected ? "bg-red-100 text-red-700" :
                                isPending ? "bg-gray-100 text-gray-500" :
                                !isAvailable ? "bg-red-100 text-red-700" :
                                numCategory === "MARKETING" ? "bg-orange-100 text-orange-700" :
                                "bg-green-100 text-green-700"
                              }`}
                            >
                              <a href={`https://business.facebook.com/wa/manage/phone-numbers/?waba_id=${pn.wabaid}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                {pn.displayName} {isRejected ? "✗" : isPending ? "⏳" : isAvailable ? "✓" : "✗"}
                                {isAvailable && !isPending && !isRejected && numCategory && <span className="ml-0.5 font-semibold">{numCategory === "MARKETING" ? "M" : "U"}</span>}
                                {isPending && <span className="ml-0.5 text-[9px]">review</span>}
                                {isRejected && <span className="ml-0.5 text-[9px]">rejected</span>}
                              </a>
                              <span className="flex items-center gap-1">
                                <a href={`https://business.facebook.com/wa/manage/message-templates/?waba_id=${pn.wabaid}`} target="_blank" rel="noopener noreferrer" className="block text-[9px] opacity-70 hover:underline hover:opacity-100">
                                  {pn.displayNumber}
                                </a>
                                {(isAvailable || isPending || isRejected) && (
                                  <button
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); openNumberPreview(tpl.templateName, pn); }}
                                    title={`Preview ${tpl.templateName} on ${pn.displayNumber}`}
                                    aria-label={`Preview ${tpl.templateName} on ${pn.displayNumber}`}
                                    className="opacity-60 hover:opacity-100"
                                  >
                                    <Eye className="w-3 h-3" />
                                  </button>
                                )}
                              </span>
                              {/* Re-sync just this one number's WABA (a single Meta call) —
                                  isolates whether a number missing this template is a real
                                  gap on Meta's side vs. an artifact of the full sync's
                                  concurrent fan-out. Shown on hover to stay out of the way. */}
                              {(selectedBiz?.provider || "meta") !== "aisensy" && (
                                <button
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); syncOneNumber(pn.phoneNumberId); }}
                                  disabled={syncingNumber === pn.phoneNumberId}
                                  title={`Re-sync just ${pn.displayName} (${pn.displayNumber})`}
                                  className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-4 h-4 bg-white border border-gray-300 rounded-full shadow-sm text-gray-500 hover:text-primary-700 disabled:opacity-50"
                                >
                                  <RefreshCw className={`w-2.5 h-2.5 ${syncingNumber === pn.phoneNumberId ? "animate-spin" : ""}`} />
                                </button>
                              )}
                            </span>
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0 w-[260px]">
                      <div className="flex items-center gap-2">
                        {/* Re-sync just this one template — cheaper than the full "Sync from
                            Meta" above when only one row looks stale. */}
                        {(selectedBiz?.provider || "meta") !== "aisensy" && (
                          <button
                            onClick={() => syncOneTemplate(tpl.templateName)}
                            disabled={syncingTemplate === tpl.templateName}
                            title="Check this template's latest status on every number"
                            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded-lg hover:bg-green-100 disabled:opacity-50"
                          >
                            <RefreshCw className={`w-3 h-3 ${syncingTemplate === tpl.templateName ? "animate-spin" : ""}`} />
                            {syncingTemplate === tpl.templateName ? "Syncing…" : "Sync with Meta"}
                          </button>
                        )}
                        {/* Copy button — shown if there's somewhere left to copy to: more
                            numbers on this business, or another business entirely */}
                        {(tpl.availableOn.length < (selectedBiz?.phoneNumbers.length || 0) || businesses.length > 1) && (
                          <button
                            onClick={() => {
                              setCopyTemplate(tpl);
                              setSourceNumber(tpl.availableOn[0]);
                              setCopyTargetBusinessId(selectedBiz?.businessId || "");
                              setTargetWabas([]);
                              setCopyResults([]);
                              setHeaderImageUrl("");
                            }}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100"
                          >
                            <Copy className="w-3 h-3" />
                            Copy to others
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-gray-500 text-right">
                        Last updated: {formatSyncedAt(tpl.lastSyncedAt)}
                        {syncResult[tpl.templateName] && (
                          <span className="block text-gray-600">{syncResult[tpl.templateName]}</span>
                        )}
                      </p>
                      {/* Inline preview: the first number (in the list order on the
                          left) that has this template. The eye icon on any number
                          shows that number's own copy, which can differ in structure. */}
                      {(() => {
                        const first = selectedBiz?.phoneNumbers.find((pn) => tpl.availableOn.includes(pn.phoneNumberId));
                        if (!first || !tpl.components?.length) return null;
                        const { values, headerImageUrl: img } = previewInputs(tpl.components);
                        return (
                          <div className="w-full">
                            <p className="text-[10px] text-gray-400 mb-1 text-right">
                              Preview · {first.displayName} {first.displayNumber}
                            </p>
                            <TemplatePreview template={{ components: tpl.components }} resolvedValues={values} headerImageUrl={img} />
                          </div>
                        );
                      })()}
                      </div>
                    </div>
                  </div>
                ))}
                {filtered.length > visibleCount && (
                  <div className="flex items-center justify-center gap-3 pt-2">
                    <span className="text-xs text-gray-500">
                      Showing {visibleCount} of {filtered.length}
                    </span>
                    <button
                      onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                      className="px-3 py-1.5 text-xs bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      Show more
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Per-number template preview (eye icon) */}
            {preview && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPreview(null)}>
                <div className="bg-white rounded-xl w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="font-medium text-gray-900 text-sm">{preview.templateName}</p>
                      <p className="text-xs text-gray-500">
                        {preview.number.displayName} · {preview.number.displayNumber}
                        {preview.data?.category && <> · {preview.data.category}</>}
                        {preview.data?.status && <> · {String(preview.data.status).toLowerCase()}</>}
                      </p>
                    </div>
                    <button onClick={() => setPreview(null)} aria-label="Close preview" className="text-gray-400 hover:text-gray-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  {preview.loading ? (
                    <p className="text-xs text-gray-400 py-10 text-center">Loading preview…</p>
                  ) : preview.error || !preview.data ? (
                    <p className="text-xs text-red-600 py-10 text-center">{preview.error || "No template data"}</p>
                  ) : (
                    (() => {
                      const { values, headerImageUrl: img } = previewInputs(preview.data.components);
                      return <TemplatePreview template={{ components: preview.data.components }} resolvedValues={values} headerImageUrl={img} />;
                    })()
                  )}
                </div>
              </div>
            )}

            {/* Copy Modal */}
            {copyTemplate && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl p-6 max-w-md w-full">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">Copy Template</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Submit &quot;{copyTemplate.templateName}&quot; to other numbers for Meta approval.
                  </p>

                  {/* Source */}
                  <div className="mb-4">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Copy from:</label>
                    <select
                      value={sourceNumber}
                      onChange={(e) => setSourceNumber(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    >
                      {copyTemplate.availableOn.map((id) => {
                        const cat = copyTemplate.categoryPerNumber?.[id];
                        const pn = selectedBiz?.phoneNumbers.find((p) => p.phoneNumberId === id);
                        return (
                          <option key={id} value={id}>
                            {pn?.displayName || id} — {pn?.displayNumber || ""} [{cat || "?"}]
                          </option>
                        );
                      })}
                    </select>
                    {copyTemplate.categoryPerNumber?.[sourceNumber] === "MARKETING" && (
                      <p className="text-xs text-orange-600 mt-1 font-medium">⚠️ This source is MARKETING — the copy will also be MARKETING</p>
                    )}
                  </div>

                  {/* Target business — defaults to the current one (numbers within
                      it), but can point at any other business in this account.
                      Cross-business copy uses THAT business's own access token
                      to create the template (see templates/copy.ts) since the
                      source's token has no permission on a different Business
                      Manager's WABA. */}
                  {businesses.length > 1 && (
                    <div className="mb-4">
                      <label className="text-xs font-medium text-gray-600 mb-1 block">Copy to business:</label>
                      <select
                        value={copyTargetBusinessId}
                        onChange={(e) => { setCopyTargetBusinessId(e.target.value); setTargetWabas([]); }}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        {businesses.map((b) => (
                          <option key={b.businessId} value={b.businessId}>
                            {b.businessName}{b.businessId === selectedBiz?.businessId ? " (same business)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Targets */}
                  <div className="mb-4">
                    {(() => {
                      const copyTargetBiz = businesses.find((b) => b.businessId === copyTargetBusinessId) || selectedBiz;
                      const isCrossBusiness = copyTargetBiz?.businessId !== selectedBiz?.businessId;
                      const copyTargetNumbers = (copyTargetBiz?.phoneNumbers || []).filter(
                        (pn) => isCrossBusiness || !copyTemplate.availableOn.includes(pn.phoneNumberId)
                      );
                      const copyTargetWabas = copyTargetNumbers.map((pn) => pn.wabaid || "").filter(Boolean);
                      const allChecked = copyTargetWabas.length > 0 && copyTargetWabas.every((w) => targetWabas.includes(w));
                      return (
                        <>
                          <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-medium text-gray-600 block">Submit to:</label>
                            <button
                              onClick={() => setTargetWabas(allChecked ? [] : copyTargetWabas)}
                              className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                            >
                              {allChecked ? "Uncheck All" : "Check All"}
                            </button>
                          </div>
                          {copyTargetNumbers.length === 0 ? (
                            <p className="text-xs text-gray-400 py-2">
                              {isCrossBusiness ? "This business has no numbers configured." : "Already on every number for this business."}
                            </p>
                          ) : (
                            <div className="space-y-2 max-h-56 overflow-y-auto pr-1 border border-gray-100 rounded-lg p-2">
                              {copyTargetNumbers.map((pn) => (
                                <label key={pn.phoneNumberId} className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={targetWabas.includes(pn.wabaid || "")}
                                    onChange={() => pn.wabaid && toggleTargetWaba(pn.wabaid)}
                                    className="w-4 h-4 text-blue-600 rounded"
                                  />
                                  <span className="text-sm text-gray-700">{pn.displayName}</span>
                                  <span className="text-xs text-gray-400">({pn.displayNumber})</span>
                                </label>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {/* Image picker for image header templates — Meta rejects the
                      submission with a bare "Invalid parameter" if an image-header
                      template is copied with no example image, so this is enforced
                      below rather than just labeled "required". */}
                  {copyTemplate.hasImageHeaderPerNumber && Object.values(copyTemplate.hasImageHeaderPerNumber).some(Boolean) && (
                    <div className="mb-4">
                      <label className="text-xs font-medium text-gray-600 mb-1 block">Header Image (required for this template):</label>
                      <ImagePicker value={headerImageUrl} onChange={setHeaderImageUrl} />
                      {!headerImageUrl && (
                        <p className="text-xs text-orange-600 mt-1">Pick a header image before submitting — Meta will reject this template without one.</p>
                      )}
                    </div>
                  )}

                  {/* Results */}
                  {copyResults.length > 0 && (
                    <div className="mb-4 space-y-1 max-h-56 overflow-y-auto pr-1 border border-gray-100 rounded-lg p-2">
                      {copyResults.map((r, i) => (
                        <div key={i} className={`flex items-center gap-2 text-sm p-2 rounded ${
                          r.status === "submitted" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                        }`}>
                          {r.status === "submitted" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                          <span>{getNumberByWaba(r.wabaid)?.displayName || r.wabaid}: {r.status}</span>
                          {r.error && <span className="text-xs">({r.error})</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setCopyTemplate(null)}
                      className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                    >
                      Close
                    </button>
                    <button
                      onClick={handleCopy}
                      disabled={
                        targetWabas.length === 0 ||
                        copying ||
                        (Boolean(copyTemplate.hasImageHeaderPerNumber) &&
                          Object.values(copyTemplate.hasImageHeaderPerNumber || {}).some(Boolean) &&
                          !headerImageUrl)
                      }
                      className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg disabled:opacity-50 hover:bg-blue-700"
                    >
                      {copying ? "Submitting..." : `Submit to ${targetWabas.length} number${targetWabas.length !== 1 ? "s" : ""}`}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Create Template Modal (Meta) */}
            {showCreate && selectedBiz && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">Create Template</h3>
                  <p className="text-sm text-gray-500 mb-4">Submit a new template to Meta for approval.</p>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-xs font-medium text-gray-600 mb-1 block">Name (lowercase_with_underscores)</label>
                      <input
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 mb-1 block">Category</label>
                      <select
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value as "UTILITY" | "MARKETING")}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        <option value="UTILITY">Utility</option>
                        <option value="MARKETING">Marketing</option>
                      </select>
                    </div>
                  </div>

                  <div className="mb-3">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Language code</label>
                    <input
                      type="text"
                      value={newLanguage}
                      onChange={(e) => setNewLanguage(e.target.value)}
                      placeholder="en_US"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="mb-3">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Header text (optional)</label>
                    <input
                      type="text"
                      value={newHeaderText}
                      onChange={(e) => setNewHeaderText(e.target.value)}
                      disabled={Boolean(newHeaderImageUrl)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                    />
                  </div>

                  <div className="mb-3">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Header image (optional, overrides header text)</label>
                    <ImagePicker value={newHeaderImageUrl} onChange={setNewHeaderImageUrl} />
                  </div>

                  <div className="mb-3">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">
                      Body text — use {"{{1}}"}, {"{{2}}"}, etc. for variables
                    </label>
                    <textarea
                      value={newBody}
                      onChange={(e) => setNewBody(e.target.value)}
                      rows={4}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  {newBodyParamNumbers.length > 0 && (
                    <div className="mb-3">
                      <label className="text-xs font-medium text-gray-600 mb-2 block">
                        Example values — Meta requires a sample for each variable
                      </label>
                      <div className="space-y-2">
                        {newBodyParamNumbers.map((n) => (
                          <div key={n} className="flex items-center gap-3">
                            <span className="text-xs text-gray-500 w-10">{`{{${n}}}`}</span>
                            <input
                              type="text"
                              value={newBodyExamples[n] || ""}
                              onChange={(e) => setNewBodyExamples((prev) => ({ ...prev, [n]: e.target.value }))}
                              placeholder={`Example value for {{${n}}}`}
                              className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mb-4">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Footer text (optional)</label>
                    <input
                      type="text"
                      value={newFooter}
                      onChange={(e) => setNewFooter(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-medium text-gray-600 block">Buttons (optional, up to 3)</label>
                      {newButtons.length < 3 && (
                        <button onClick={addNewButton} className="text-xs text-primary-600 hover:text-primary-700 font-medium flex items-center gap-0.5">
                          <Plus className="w-3 h-3" /> Add button
                        </button>
                      )}
                    </div>
                    {newButtons.length > 0 && (
                      <div className="space-y-2">
                        {newButtons.map((btn, i) => (
                          <div key={i} className="flex items-start gap-2 border border-gray-200 rounded-lg p-2">
                            <select
                              value={btn.type}
                              onChange={(e) => updateNewButton(i, { type: e.target.value as "QUICK_REPLY" | "PHONE_NUMBER" | "URL" })}
                              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs shrink-0"
                            >
                              <option value="QUICK_REPLY">Quick Reply</option>
                              <option value="URL">Website URL</option>
                              <option value="PHONE_NUMBER">Call Phone</option>
                            </select>
                            <div className="flex-1 space-y-1.5">
                              <input
                                type="text"
                                value={btn.text}
                                onChange={(e) => updateNewButton(i, { text: e.target.value })}
                                placeholder="Button text"
                                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs"
                              />
                              {btn.type === "URL" && (
                                <input
                                  type="text"
                                  value={btn.url || ""}
                                  onChange={(e) => updateNewButton(i, { url: e.target.value })}
                                  placeholder="https://example.com"
                                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs"
                                />
                              )}
                              {btn.type === "PHONE_NUMBER" && (
                                <input
                                  type="text"
                                  value={btn.phoneNumber || ""}
                                  onChange={(e) => updateNewButton(i, { phoneNumber: e.target.value })}
                                  placeholder="+91XXXXXXXXXX"
                                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs"
                                />
                              )}
                            </div>
                            <button onClick={() => removeNewButton(i)} className="text-red-400 hover:text-red-600 shrink-0 mt-1.5">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-gray-600 block">Submit to:</label>
                      <button
                        onClick={() =>
                          setNewTargets(
                            newTargets.length === selectedBiz.phoneNumbers.length
                              ? []
                              : selectedBiz.phoneNumbers.map((pn) => pn.phoneNumberId)
                          )
                        }
                        className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                      >
                        {newTargets.length === selectedBiz.phoneNumbers.length ? "Uncheck All" : "Check All"}
                      </button>
                    </div>
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1 border border-gray-100 rounded-lg p-2">
                      {selectedBiz.phoneNumbers.map((pn) => (
                        <label key={pn.phoneNumberId} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newTargets.includes(pn.phoneNumberId)}
                            onChange={() => toggleNewTarget(pn.phoneNumberId)}
                            className="w-4 h-4 text-blue-600 rounded"
                          />
                          <span className="text-sm text-gray-700">{pn.displayName}</span>
                          <span className="text-xs text-gray-400">({pn.displayNumber})</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {createResults.length > 0 && (
                    <div className="mb-4 space-y-1">
                      {createResults.map((r, i) => (
                        <div key={i} className={`flex items-center gap-2 text-sm p-2 rounded ${
                          r.status === "submitted" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                        }`}>
                          {r.status === "submitted" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                          <span>{r.displayName}: {r.status}</span>
                          {r.error && <span className="text-xs">({r.error})</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                      Close
                    </button>
                    <button
                      onClick={handleCreateTemplate}
                      disabled={creating || !newName.trim() || !newBody.trim() || newTargets.length === 0}
                      className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg disabled:opacity-50 hover:bg-primary-700"
                    >
                      {creating ? "Submitting..." : `Submit to ${newTargets.length} number${newTargets.length !== 1 ? "s" : ""}`}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Manual Add Template Modal (AiSensy) */}
            {showManualAdd && selectedBiz && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl p-6 max-w-md w-full">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">Add Template Manually</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    AiSensy has no template-list API — register the campaign name here so it shows up for campaigns.
                  </p>

                  <div className="mb-3">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Template name (AiSensy campaign name)</label>
                    <input
                      type="text"
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="mb-4">
                    <label className="text-xs font-medium text-gray-600 mb-1 block"># Parameters</label>
                    <input
                      type="number"
                      min={0}
                      value={manualParamCount}
                      onChange={(e) => setManualParamCount(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="flex justify-end gap-2">
                    <button onClick={() => setShowManualAdd(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                      Close
                    </button>
                    <button
                      onClick={handleAddManualTemplate}
                      disabled={addingManual || !manualName.trim()}
                      className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg disabled:opacity-50 hover:bg-primary-700"
                    >
                      {addingManual ? "Adding..." : "Add"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
      </AppShell>
    </AuthGuard>
  );
}
