"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Save, Plus, Trash2, Search, ChevronDown, ChevronRight } from "lucide-react";

interface Business {
  businessId: string;
  businessName: string;
  phoneNumbers: { phoneNumberId: string; displayName: string; displayNumber: string }[];
}

interface NumberConfig {
  templateName: string;
  bodyParams: string[];
  imageType: string | null;
}

interface RunKeyConfig {
  numbers: Record<string, NumberConfig>;
}

interface WorkshopConfig {
  wsCode: string;
  workshopName: string;
  cycle: number;
  businessId: string;
  numbers: Record<string, { displayName: string }>;
  runKeys: Record<string, RunKeyConfig>;
  customParams?: Record<string, string>;
}

interface TemplateItem {
  templateName: string;
  parameterCount: number;
  components: { type: string; text?: string }[];
}

const WORKSHOP_CODES = ["aitools", "msai", "aidash", "aibuild"];
const DB_PARAMS = ["name", "zoom_link", "whatsapp_group", "workshop_name", "workshop_date", "workshop_time"];
const COMPUTED_PARAMS = ["full_workshop_name", "workshop_name_w", "workshop_date_time", "workshop_time_short", "mentor_name", "w_type", "w_name", "three_hours_text", "duration"];
const DEFAULT_RUN_KEYS = [
  "2days_to_go", "1day_to_go", "9am_groupjoin", "1pm_group_join", "3pm_group_join",
  "60_mins_to_go", "20_mins_to_go", "we_are_live",
  "its_7_pm", "its_7_10_pm", "its_7_20_pm", "its_7_30_pm",
  "its_11_am", "its_11_10_am", "its_11_20_am", "its_11_30_am",
];

export default function WorkshopConfigPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [config, setConfig] = useState<WorkshopConfig | null>(null);
  const [wsCode, setWsCode] = useState("aitools");
  const [cycle, setCycle] = useState(0);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [selectedNumbers, setSelectedNumbers] = useState<string[]>([]);
  const [templates, setTemplates] = useState<Record<string, TemplateItem[]>>({});
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(new Set(["2days_to_go"]));
  const [runKeyFilter, setRunKeyFilter] = useState("");
  const [newParamKey, setNewParamKey] = useState("");
  const [newParamValue, setNewParamValue] = useState("");
  const [tplSearches, setTplSearches] = useState<Record<string, string>>({});

  useEffect(() => { apiRequest<{ businesses: Business[] }>("/businesses").then((d) => setBusinesses(d.businesses)); }, []);
  useEffect(() => { loadConfig(); }, [wsCode, cycle]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3000); return () => clearTimeout(t); } }, [toast]);

  useEffect(() => {
    if (config?.businessId && selectedNumbers.length > 0) {
      const params = new URLSearchParams({ businessId: config.businessId, phoneNumberIds: selectedNumbers.join(",") });
      apiRequest<{ templates: (TemplateItem & { availableOn: string[] })[] }>(`/templates?${params}`)
        .then((data) => {
          const byNumber: Record<string, TemplateItem[]> = {};
          for (const tpl of data.templates) {
            for (const numId of tpl.availableOn) {
              if (!byNumber[numId]) byNumber[numId] = [];
              byNumber[numId].push({ templateName: tpl.templateName, parameterCount: tpl.parameterCount, components: tpl.components });
            }
          }
          setTemplates(byNumber);
        }).catch(() => {});
    }
  }, [config?.businessId, selectedNumbers]);

  const loadConfig = async () => {
    try {
      const data = await apiRequest<{ config: WorkshopConfig | null }>(`/workshops/config?wsCode=${wsCode}&cycle=${cycle}`);
      if (data.config) { setConfig(data.config); setSelectedNumbers(Object.keys(data.config.numbers || {})); }
      else { setConfig(null); setSelectedNumbers([]); }
    } catch { setConfig(null); }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try { await apiRequest("/workshops/config", { method: "PUT", body: JSON.stringify(config) }); setToast("✓ Saved"); }
    catch { setToast("✗ Failed"); }
    finally { setSaving(false); }
  };

  const toggleNumber = (phoneNumberId: string, displayName: string) => {
    if (!config) return;
    const newNumbers = { ...config.numbers };
    if (newNumbers[phoneNumberId]) {
      delete newNumbers[phoneNumberId];
      const newRunKeys = { ...config.runKeys };
      for (const rk of Object.keys(newRunKeys)) { const nums = { ...newRunKeys[rk].numbers }; delete nums[phoneNumberId]; newRunKeys[rk] = { numbers: nums }; }
      setConfig({ ...config, numbers: newNumbers, runKeys: newRunKeys });
    } else { newNumbers[phoneNumberId] = { displayName }; setConfig({ ...config, numbers: newNumbers }); }
    setSelectedNumbers(Object.keys(newNumbers));
  };

  const updateRunKeyTemplate = (runKey: string, phoneNumberId: string, field: string, value: unknown) => {
    if (!config) return;
    const newRunKeys = { ...config.runKeys };
    if (!newRunKeys[runKey]) newRunKeys[runKey] = { numbers: {} };
    if (!newRunKeys[runKey].numbers[phoneNumberId]) newRunKeys[runKey].numbers[phoneNumberId] = { templateName: "", bodyParams: [], imageType: null };
    (newRunKeys[runKey].numbers[phoneNumberId] as unknown as Record<string, unknown>)[field] = value;
    setConfig({ ...config, runKeys: newRunKeys });
  };

  const toggleRunKey = (rk: string) => {
    const s = new Set(expandedRunKeys);
    s.has(rk) ? s.delete(rk) : s.add(rk);
    setExpandedRunKeys(s);
  };

  const initConfig = (businessId: string) => {
    setConfig({ wsCode, workshopName: wsCode, cycle, businessId, numbers: {}, runKeys: {}, customParams: {} });
  };

  const allParamKeys = [...DB_PARAMS, ...COMPUTED_PARAMS, ...Object.keys(config?.customParams || {}).map((k) => `__CUSTOM__${k}`)];

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50">
          <div className="max-w-5xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Workshop Config</h2>
                <p className="text-sm text-gray-500 mt-1">Template routing per number per run key</p>
              </div>
              <button onClick={handleSave} disabled={saving || !config} className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-primary-700 shadow-sm">
                <Save className="w-4 h-4" />
                {saving ? "Saving..." : "Save"}
              </button>
            </div>

            {/* Workshop + Cycle selector */}
            <div className="flex items-center gap-4 mb-6">
              <select value={wsCode} onChange={(e) => setWsCode(e.target.value)} className="bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm font-medium shadow-sm">
                {WORKSHOP_CODES.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
              </select>
              <div className="flex bg-white border border-gray-200 rounded-xl p-1 shadow-sm">
                {[0, 1, 2, 3, 4].map((c) => (
                  <button key={c} onClick={() => setCycle(c)} className={`px-4 py-2 text-xs font-medium rounded-lg transition-all ${cycle === c ? "bg-primary-600 text-white shadow" : "text-gray-500 hover:text-gray-900"}`}>
                    {c === 0 ? "Current" : `Cycle ${c}`}
                  </button>
                ))}
              </div>
            </div>

            {!config ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center shadow-sm">
                <p className="text-gray-500 mb-6">No config exists for <span className="font-medium">{wsCode}</span> Cycle {cycle}</p>
                <div className="flex gap-3 justify-center">
                  {businesses.map((biz) => (
                    <button key={biz.businessId} onClick={() => initConfig(biz.businessId)} className="px-5 py-2.5 bg-primary-50 text-primary-700 rounded-xl text-sm font-medium hover:bg-primary-100 border border-primary-200">
                      Create with {biz.businessName}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Numbers */}
                <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">Sending Numbers</h3>
                  {!config.businessId ? (
                    <div>
                      <p className="text-xs text-gray-500 mb-3">Select a business first:</p>
                      <div className="flex gap-2">
                        {businesses.map((biz) => (
                          <button key={biz.businessId} onClick={() => setConfig({ ...config, businessId: biz.businessId })} className="px-4 py-2 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100 border border-primary-200">
                            {biz.businessName}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                  <div className="flex flex-wrap gap-3">
                    {businesses.find((b) => b.businessId === config.businessId)?.phoneNumbers.map((pn) => (
                      <label key={pn.phoneNumberId} className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 cursor-pointer transition-all ${selectedNumbers.includes(pn.phoneNumberId) ? "border-primary-500 bg-primary-50 shadow-sm" : "border-gray-100 hover:border-gray-300"}`}>
                        <input type="checkbox" checked={selectedNumbers.includes(pn.phoneNumberId)} onChange={() => toggleNumber(pn.phoneNumberId, pn.displayName)} className="w-4 h-4 text-primary-600 rounded" />
                        <div>
                          <p className="text-sm font-medium text-gray-900">{pn.displayName}</p>
                          <p className="text-xs text-gray-400">{pn.displayNumber}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Run Keys */}
                {selectedNumbers.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Template Mapping</h3>
                      <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input type="text" value={runKeyFilter} onChange={(e) => setRunKeyFilter(e.target.value)} placeholder="Filter run keys..." className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm w-48" />
                      </div>
                    </div>

                    <div className="space-y-2">
                      {DEFAULT_RUN_KEYS.filter((rk) => rk.includes(runKeyFilter.toLowerCase())).map((runKey) => (
                        <div key={runKey} className="border border-gray-100 rounded-xl">
                          <button onClick={() => toggleRunKey(runKey)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors">
                            <span className="text-sm font-medium text-gray-900">{runKey}</span>
                            {expandedRunKeys.has(runKey) ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                          </button>

                          {expandedRunKeys.has(runKey) && (
                            <div className="px-4 pb-4 space-y-4 border-t border-gray-100 pt-3 overflow-visible">
                              {selectedNumbers.map((numId) => {
                                const numConfig = config.runKeys[runKey]?.numbers[numId] || { templateName: "", bodyParams: [], imageType: null };
                                const numName = config.numbers[numId]?.displayName || numId;
                                const searchKey = `${runKey}_${numId}`;
                                const tplSearch = tplSearches[searchKey] || "";

                                return (
                                  <div key={numId} className="pl-4 border-l-3 border-primary-200">
                                    <p className="text-xs font-medium text-gray-600 mb-2">{numName}</p>
                                    
                                    {/* Searchable template dropdown */}
                                    <div className="relative mb-2">
                                      <input
                                        type="text"
                                        value={numConfig.templateName || tplSearch}
                                        onChange={(e) => {
                                          setTplSearches({ ...tplSearches, [searchKey]: e.target.value });
                                          if (numConfig.templateName) updateRunKeyTemplate(runKey, numId, "templateName", "");
                                        }}
                                        onFocus={() => setTplSearches({ ...tplSearches, [`${searchKey}_open`]: "1" })}
                                        onBlur={() => setTimeout(() => setTplSearches({ ...tplSearches, [`${searchKey}_open`]: "" }), 200)}
                                        placeholder="Search & select template..."
                                        className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent ${numConfig.templateName ? "border-primary-300 bg-primary-50 font-medium" : "border-gray-200"}`}
                                      />
                                      {tplSearches[`${searchKey}_open`] && !numConfig.templateName && (
                                        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-56 overflow-y-auto">
                                          {(templates[numId] || [])
                                            .filter((t) => t.templateName.includes((tplSearches[searchKey] || "").toLowerCase()))
                                            .map((tpl) => {
                                              return (
                                                <button
                                                  key={tpl.templateName}
                                                  onMouseDown={(e) => {
                                                    e.preventDefault();
                                                    updateRunKeyTemplate(runKey, numId, "templateName", tpl.templateName);
                                                    updateRunKeyTemplate(runKey, numId, "bodyParams", Array(tpl.parameterCount).fill(""));
                                                    setTplSearches({ ...tplSearches, [searchKey]: "", [`${searchKey}_open`]: "" });
                                                  }}
                                                  className="w-full text-left px-3 py-2.5 hover:bg-primary-50 transition-colors border-b border-gray-50 last:border-0"
                                                >
                                                  <span className="text-sm text-gray-900">{tpl.templateName}</span>
                                                  <span className="text-xs text-gray-400 ml-2">({tpl.parameterCount}p)</span>
                                                </button>
                                              );
                                            })}
                                          {(templates[numId] || []).filter((t) => t.templateName.includes((tplSearches[searchKey] || "").toLowerCase())).length === 0 && (
                                            <p className="px-3 py-3 text-xs text-gray-400 text-center">No templates found</p>
                                          )}
                                        </div>
                                      )}
                                    </div>

                                    {/* Template body preview */}
                                    {numConfig.templateName && (() => {
                                      const tpl = (templates[numId] || []).find((t) => t.templateName === numConfig.templateName);
                                      const bodyText = tpl?.components?.find((c) => (c.type as string).toUpperCase() === "BODY")?.text;
                                      return bodyText ? (
                                        <div className="mb-3 p-3 bg-gradient-to-r from-slate-50 to-gray-50 rounded-lg text-xs text-gray-600 whitespace-pre-wrap border border-gray-100 leading-relaxed">
                                          {bodyText}
                                        </div>
                                      ) : null;
                                    })()}

                                    {/* Params */}
                                    <div className="flex flex-wrap gap-1.5 items-center">
                                      {(numConfig.bodyParams || []).map((param, idx) => {
                                        const paramSearchKey = `param_${runKey}_${numId}_${idx}`;
                                        const paramSearch = tplSearches[paramSearchKey] || "";
                                        const paramOpen = tplSearches[`${paramSearchKey}_open`];
                                        const allParams = [...DB_PARAMS, ...COMPUTED_PARAMS, ...Object.keys(config.customParams || {}).map((k) => `__CUSTOM__${k}`)];
                                        const displayValue = param.startsWith("__CUSTOM__") ? `⚡ ${param.replace("__CUSTOM__", "")}` : param;

                                        return (
                                          <div key={idx} className="relative">
                                            <div className="flex items-center bg-white rounded-lg border border-gray-200 shadow-sm">
                                              <input
                                                type="text"
                                                value={param ? displayValue : paramSearch}
                                                onChange={(e) => {
                                                  setTplSearches({ ...tplSearches, [paramSearchKey]: e.target.value });
                                                  if (param) { const p = [...(numConfig.bodyParams || [])]; p[idx] = ""; updateRunKeyTemplate(runKey, numId, "bodyParams", p); }
                                                }}
                                                onFocus={() => setTplSearches({ ...tplSearches, [`${paramSearchKey}_open`]: "1" })}
                                                onBlur={() => setTimeout(() => setTplSearches({ ...tplSearches, [`${paramSearchKey}_open`]: "" }), 200)}
                                                placeholder="param..."
                                                className={`w-28 border-0 bg-transparent rounded-lg px-2 py-1.5 text-xs font-medium focus:ring-0 ${param ? "text-gray-900" : "text-gray-400"}`}
                                              />
                                              <button onClick={() => {
                                                const p = [...(numConfig.bodyParams || [])]; p.splice(idx, 1);
                                                updateRunKeyTemplate(runKey, numId, "bodyParams", p);
                                              }} className="text-red-300 hover:text-red-500 pr-2"><Trash2 className="w-3 h-3" /></button>
                                            </div>
                                            {paramOpen && !param && (
                                              <div className="absolute z-50 w-44 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-40 overflow-y-auto">
                                                {allParams.filter((p) => p.toLowerCase().includes(paramSearch.toLowerCase())).map((p) => (
                                                  <button
                                                    key={p}
                                                    onMouseDown={(e) => {
                                                      e.preventDefault();
                                                      const params = [...(numConfig.bodyParams || [])]; params[idx] = p;
                                                      updateRunKeyTemplate(runKey, numId, "bodyParams", params);
                                                      setTplSearches({ ...tplSearches, [paramSearchKey]: "", [`${paramSearchKey}_open`]: "" });
                                                    }}
                                                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-primary-50 transition-colors"
                                                  >
                                                    {p.startsWith("__CUSTOM__") ? `⚡ ${p.replace("__CUSTOM__", "")}` : p}
                                                  </button>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                      <button onClick={() => updateRunKeyTemplate(runKey, numId, "bodyParams", [...(numConfig.bodyParams || []), ""])} className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-0.5 px-2 py-1.5 rounded-lg hover:bg-primary-50 border border-dashed border-primary-200">
                                        <Plus className="w-3 h-3" /> param
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {toast && <div className="fixed bottom-6 right-6 px-5 py-3 rounded-xl shadow-lg text-sm font-medium bg-gray-900 text-white z-50">{toast}</div>}
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
