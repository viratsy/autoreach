"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Copy, CheckCircle, XCircle, RefreshCw, ExternalLink, Plus } from "lucide-react";
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
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"ALL" | "UTILITY" | "MARKETING">("ALL");

  // Copy state
  const [copyTemplate, setCopyTemplate] = useState<TemplateInfo | null>(null);
  const [sourceNumber, setSourceNumber] = useState("");
  const [targetWabas, setTargetWabas] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  const [copyResults, setCopyResults] = useState<{ wabaid: string; status: string; error?: string }[]>([]);
  const [headerImageUrl, setHeaderImageUrl] = useState("");

  // Create template (Meta) state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [newLanguage, setNewLanguage] = useState("en_US");
  const [newBody, setNewBody] = useState("");
  const [newHeaderText, setNewHeaderText] = useState("");
  const [newHeaderImageUrl, setNewHeaderImageUrl] = useState("");
  const [newFooter, setNewFooter] = useState("");
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
    setNewHeaderText("");
    setNewHeaderImageUrl("");
    setNewFooter("");
    setNewTargets([]);
    setCreateResults([]);
  };

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
          headerText: newHeaderImageUrl ? undefined : newHeaderText || undefined,
          headerImageUrl: newHeaderImageUrl || undefined,
          footerText: newFooter || undefined,
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
    selectedBiz?.phoneNumbers.find((p) => p.wabaid === wabaid);

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
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
                    disabled={syncing}
                    className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
                    {syncing ? "Syncing..." : selectedBiz?.provider === "wati" ? "Sync from WATI" : "Sync from Meta"}
                  </button>
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
                {filtered.map((tpl) => (
                  <div key={tpl.templateName} className={`bg-white rounded-lg border p-4 ${tpl.category === "MARKETING" ? "border-orange-200" : "border-gray-200"}`}>
                    <div className="flex items-center justify-between">
                      <div>
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
                              className={`text-xs px-1.5 py-0.5 rounded ${
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
                              <a href={`https://business.facebook.com/wa/manage/message-templates/?waba_id=${pn.wabaid}`} target="_blank" rel="noopener noreferrer" className="block text-[9px] opacity-70 hover:underline hover:opacity-100">
                                {pn.displayNumber}
                              </a>
                            </span>
                            );
                          })}
                        </div>
                      </div>
                      {/* Copy button - only show if not on all numbers */}
                      {tpl.availableOn.length < (selectedBiz?.phoneNumbers.length || 0) && (
                        <button
                          onClick={() => {
                            setCopyTemplate(tpl);
                            setSourceNumber(tpl.availableOn[0]);
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
                  </div>
                ))}
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

                  {/* Targets */}
                  <div className="mb-4">
                    {(() => {
                      const copyTargetNumbers = (selectedBiz?.phoneNumbers || []).filter(
                        (pn) => !copyTemplate.availableOn.includes(pn.phoneNumberId)
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
                          <div className="space-y-2">
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
                        </>
                      );
                    })()}
                  </div>

                  {/* Image picker for image header templates */}
                  {copyTemplate.hasImageHeaderPerNumber && Object.values(copyTemplate.hasImageHeaderPerNumber).some(Boolean) && (
                    <div className="mb-4">
                      <label className="text-xs font-medium text-gray-600 mb-1 block">Header Image (required for this template):</label>
                      <ImagePicker value={headerImageUrl} onChange={setHeaderImageUrl} />
                    </div>
                  )}

                  {/* Results */}
                  {copyResults.length > 0 && (
                    <div className="mb-4 space-y-1">
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
                      disabled={targetWabas.length === 0 || copying}
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
                    <div className="space-y-2">
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
        </main>
      </div>
    </AuthGuard>
  );
}
