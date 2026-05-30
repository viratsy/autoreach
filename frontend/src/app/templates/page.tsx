"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Copy, CheckCircle, XCircle, RefreshCw } from "lucide-react";

interface Business {
  businessId: string;
  businessName: string;
  phoneNumbers: { phoneNumberId: string; displayName: string; wabaid: string }[];
}

interface TemplateInfo {
  templateName: string;
  category: string;
  parameterCount: number;
  availableOn: string[];
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

  // Copy state
  const [copyTemplate, setCopyTemplate] = useState<TemplateInfo | null>(null);
  const [sourceNumber, setSourceNumber] = useState("");
  const [targetWabas, setTargetWabas] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  const [copyResults, setCopyResults] = useState<{ wabaid: string; status: string; error?: string }[]>([]);

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

  const filtered = templates.filter((t) => t.templateName.toLowerCase().includes(search.toLowerCase()));

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
              <button
                onClick={syncTemplates}
                disabled={syncing}
                className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing..." : "Sync from Meta"}
              </button>
            </div>

            {/* Business selector */}
            {businesses.length > 1 && (
              <div className="mb-4">
                <select
                  value={selectedBiz?.businessId || ""}
                  onChange={(e) => setSelectedBiz(businesses.find((b) => b.businessId === e.target.value) || null)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  {businesses.map((b) => (
                    <option key={b.businessId} value={b.businessId}>{b.businessName}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Search */}
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
            />

            {/* Template list */}
            {loading ? (
              <p className="text-gray-500 text-sm">Loading...</p>
            ) : (
              <div className="space-y-2">
                {filtered.map((tpl) => (
                  <div key={tpl.templateName} className="bg-white rounded-lg border border-gray-200 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-gray-900 text-sm">{tpl.templateName}</p>
                        <p className="text-xs text-gray-500">
                          {tpl.category} • {tpl.parameterCount} params • on {tpl.availableOn.length}/{selectedBiz?.phoneNumbers.length || 0} numbers
                        </p>
                        <div className="flex gap-1 mt-1">
                          {selectedBiz?.phoneNumbers.map((pn) => (
                            <span
                              key={pn.phoneNumberId}
                              className={`text-xs px-1.5 py-0.5 rounded ${
                                tpl.availableOn.includes(pn.phoneNumberId)
                                  ? "bg-green-100 text-green-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {pn.displayName} {tpl.availableOn.includes(pn.phoneNumberId) ? "✓" : "✗"}
                            </span>
                          ))}
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
                      {copyTemplate.availableOn.map((id) => (
                        <option key={id} value={id}>{getNumberName(id)}</option>
                      ))}
                    </select>
                  </div>

                  {/* Targets */}
                  <div className="mb-4">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Submit to:</label>
                    <div className="space-y-2">
                      {selectedBiz?.phoneNumbers
                        .filter((pn) => !copyTemplate.availableOn.includes(pn.phoneNumberId))
                        .map((pn) => (
                          <label key={pn.phoneNumberId} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={targetWabas.includes(pn.wabaid)}
                              onChange={() => toggleTargetWaba(pn.wabaid)}
                              className="w-4 h-4 text-blue-600 rounded"
                            />
                            <span className="text-sm text-gray-700">{pn.displayName}</span>
                            <span className="text-xs text-gray-400">({pn.wabaid})</span>
                          </label>
                        ))}
                    </div>
                  </div>

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
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
