"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Save, Plus, Trash2 } from "lucide-react";

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

const WORKSHOP_CODES = ["aitools", "msai", "aidash", "aibuild"];
const DB_PARAMS = ["name", "zoom_link", "whatsapp_group", "workshop_name", "workshop_date", "workshop_time"];
const COMPUTED_PARAMS = ["full_workshop_name", "workshop_name_w", "workshop_date_time", "workshop_time_short", "mentor_name", "w_type", "w_name", "three_hours_text"];
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
  const [templateSearch, setTemplateSearch] = useState("");
  const [newParamKey, setNewParamKey] = useState("");
  const [newParamValue, setNewParamValue] = useState("");
  const [templates, setTemplates] = useState<Record<string, { templateName: string; parameterCount: number; components: { type: string; text?: string }[] }[]>>({});

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses").then((d) => setBusinesses(d.businesses));
  }, []);

  // Load templates for selected numbers
  useEffect(() => {
    if (config?.businessId && selectedNumbers.length > 0) {
      const params = new URLSearchParams({
        businessId: config.businessId,
        phoneNumberIds: selectedNumbers.join(","),
      });
      apiRequest<{ templates: { templateName: string; parameterCount: number; components: { type: string; text?: string }[]; availableOn: string[] }[] }>(`/templates?${params}`)
        .then((data) => {
          // Group templates by number
          const byNumber: typeof templates = {};
          for (const tpl of data.templates) {
            for (const numId of tpl.availableOn) {
              if (!byNumber[numId]) byNumber[numId] = [];
              byNumber[numId].push({ templateName: tpl.templateName, parameterCount: tpl.parameterCount, components: tpl.components });
            }
          }
          setTemplates(byNumber);
        })
        .catch(() => {});
    }
  }, [config?.businessId, selectedNumbers]);

  useEffect(() => {
    loadConfig();
  }, [wsCode, cycle]);

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(""), 3000); return () => clearTimeout(t); }
  }, [toast]);

  const loadConfig = async () => {
    try {
      const data = await apiRequest<{ config: WorkshopConfig | null }>(`/workshops/config?wsCode=${wsCode}&cycle=${cycle}`);
      if (data.config) {
        setConfig(data.config);
        setSelectedNumbers(Object.keys(data.config.numbers || {}));
      } else {
        setConfig(null);
        setSelectedNumbers([]);
      }
    } catch { setConfig(null); }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await apiRequest("/workshops/config", { method: "PUT", body: JSON.stringify(config) });
      setToast("Config saved!");
    } catch { setToast("Save failed"); }
    finally { setSaving(false); }
  };

  const toggleNumber = (phoneNumberId: string, displayName: string) => {
    if (!config) return;
    const newNumbers = { ...config.numbers };
    if (newNumbers[phoneNumberId]) {
      delete newNumbers[phoneNumberId];
      // Also remove from all runKeys
      const newRunKeys = { ...config.runKeys };
      for (const rk of Object.keys(newRunKeys)) {
        const nums = { ...newRunKeys[rk].numbers };
        delete nums[phoneNumberId];
        newRunKeys[rk] = { numbers: nums };
      }
      setConfig({ ...config, numbers: newNumbers, runKeys: newRunKeys });
      setSelectedNumbers(Object.keys(newNumbers));
    } else {
      newNumbers[phoneNumberId] = { displayName };
      setConfig({ ...config, numbers: newNumbers });
      setSelectedNumbers(Object.keys(newNumbers));
    }
  };

  const updateRunKeyTemplate = (runKey: string, phoneNumberId: string, field: string, value: string | string[] | null) => {
    if (!config) return;
    const newRunKeys = { ...config.runKeys };
    if (!newRunKeys[runKey]) newRunKeys[runKey] = { numbers: {} };
    if (!newRunKeys[runKey].numbers[phoneNumberId]) {
      newRunKeys[runKey].numbers[phoneNumberId] = { templateName: "", bodyParams: [], imageType: null };
    }
    (newRunKeys[runKey].numbers[phoneNumberId] as unknown as Record<string, unknown>)[field] = value;
    setConfig({ ...config, runKeys: newRunKeys });
  };

  const addParam = (runKey: string, phoneNumberId: string) => {
    if (!config) return;
    const current = config.runKeys[runKey]?.numbers[phoneNumberId]?.bodyParams || [];
    updateRunKeyTemplate(runKey, phoneNumberId, "bodyParams", [...current, ""]);
  };

  const removeParam = (runKey: string, phoneNumberId: string, idx: number) => {
    if (!config) return;
    const current = [...(config.runKeys[runKey]?.numbers[phoneNumberId]?.bodyParams || [])];
    current.splice(idx, 1);
    updateRunKeyTemplate(runKey, phoneNumberId, "bodyParams", current);
  };

  const updateParam = (runKey: string, phoneNumberId: string, idx: number, value: string) => {
    if (!config) return;
    const current = [...(config.runKeys[runKey]?.numbers[phoneNumberId]?.bodyParams || [])];
    current[idx] = value;
    updateRunKeyTemplate(runKey, phoneNumberId, "bodyParams", current);
  };

  const initConfig = (businessId: string) => {
    setConfig({
      wsCode,
      workshopName: WORKSHOP_CODES.includes(wsCode) ? wsCode : "",
      cycle,
      businessId,
      numbers: {},
      runKeys: {},
    });
  };

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-5xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-gray-900">Workshop Template Config</h2>
              <button onClick={handleSave} disabled={saving || !config} className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-primary-700">
                <Save className="w-4 h-4" />
                {saving ? "Saving..." : "Save Config"}
              </button>
            </div>

            {/* Selectors */}
            <div className="flex gap-3 mb-6">
              <select value={wsCode} onChange={(e) => setWsCode(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                {WORKSHOP_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <div className="flex bg-gray-100 rounded-lg p-0.5">
                {[0, 1, 2, 3, 4].map((c) => (
                  <button key={c} onClick={() => setCycle(c)} className={`px-3 py-1.5 text-xs rounded-md ${cycle === c ? "bg-white text-gray-900 shadow-sm font-medium" : "text-gray-500"}`}>
                    {c === 0 ? "Current" : `Cycle ${c}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Init or Edit */}
            {!config ? (
              <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
                <p className="text-gray-500 mb-4">No config for {wsCode} Cycle {cycle}</p>
                <div className="flex gap-2 justify-center">
                  {businesses.map((biz) => (
                    <button key={biz.businessId} onClick={() => initConfig(biz.businessId)} className="px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100">
                      Create with {biz.businessName}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {/* Number Selection */}
                <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
                  <h3 className="font-semibold text-gray-900 mb-3">Select Numbers</h3>
                  <div className="flex flex-wrap gap-2">
                    {businesses.find((b) => b.businessId === config.businessId)?.phoneNumbers.map((pn) => (
                      <label key={pn.phoneNumberId} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer ${selectedNumbers.includes(pn.phoneNumberId) ? "border-primary-500 bg-primary-50" : "border-gray-200"}`}>
                        <input type="checkbox" checked={selectedNumbers.includes(pn.phoneNumberId)} onChange={() => toggleNumber(pn.phoneNumberId, pn.displayName)} className="w-4 h-4 text-primary-600 rounded" />
                        <span className="text-sm">{pn.displayName}</span>
                        <span className="text-xs text-gray-400">{pn.displayNumber}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Custom Static Params */}
                <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
                  <h3 className="font-semibold text-gray-900 mb-1">Custom Static Parameters</h3>
                  <p className="text-xs text-gray-500 mb-3">Define static values used in templates. These appear in the param dropdown when mapping.</p>
                  
                  {/* Existing custom params - editable */}
                  <div className="space-y-2 mb-3">
                    {Object.entries(config.customParams || {}).map(([key, value]) => (
                      <div key={key} className="flex items-start gap-2 bg-gray-50 p-2 rounded">
                        <span className="text-xs font-mono bg-blue-100 text-blue-700 px-2 py-1 rounded min-w-[100px]">{key}</span>
                        <textarea
                          value={value}
                          onChange={(e) => {
                            const cp = { ...(config.customParams || {}), [key]: e.target.value };
                            setConfig({ ...config, customParams: cp });
                          }}
                          rows={2}
                          className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs resize-y"
                        />
                        <button onClick={() => {
                          const cp = { ...(config.customParams || {}) };
                          delete cp[key];
                          setConfig({ ...config, customParams: cp });
                        }} className="text-red-400 hover:text-red-600 mt-1"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    ))}
                  </div>

                  {/* Add new */}
                  <div className="flex items-center gap-2 border-t border-gray-200 pt-3">
                    <input type="text" value={newParamKey} onChange={(e) => setNewParamKey(e.target.value)} placeholder="Key name" className="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
                    <input type="text" value={newParamValue} onChange={(e) => setNewParamValue(e.target.value)} placeholder="Static value" className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm" />
                    <button onClick={() => {
                      if (newParamKey.trim()) {
                        const cp = { ...(config.customParams || {}), [newParamKey.trim()]: newParamValue };
                        setConfig({ ...config, customParams: cp });
                        setNewParamKey(""); setNewParamValue("");
                      }
                    }} className="px-3 py-1.5 bg-blue-50 text-blue-700 rounded text-sm font-medium hover:bg-blue-100 flex items-center gap-1"><Plus className="w-3 h-3" /> Add</button>
                  </div>

                  {/* Reference: DB params */}
                  <div className="mt-4 pt-3 border-t border-gray-200">
                    <p className="text-xs text-gray-400 mb-1">Available from DB (auto-filled from registration):</p>
                    <div className="flex flex-wrap gap-1">
                      {DB_PARAMS.map((p) => <span key={p} className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded">{p}</span>)}
                    </div>
                    <p className="text-xs text-gray-400 mt-2 mb-1">Computed (auto-generated):</p>
                    <div className="flex flex-wrap gap-1">
                      {COMPUTED_PARAMS.map((p) => <span key={p} className="text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded">{p}</span>)}
                    </div>
                  </div>
                </div>

                {/* Template Search */}
                {selectedNumbers.length > 0 && (
                  <div className="mb-4">
                    <input
                      type="text"
                      value={templateSearch}
                      onChange={(e) => setTemplateSearch(e.target.value)}
                      placeholder="Search run keys..."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                )}

                {/* Run Key Configs */}
                {selectedNumbers.length > 0 && (
                  <div className="space-y-4">
                    {DEFAULT_RUN_KEYS.filter((rk) => rk.includes(templateSearch.toLowerCase())).map((runKey) => (
                      <div key={runKey} className="bg-white rounded-xl border border-gray-200 p-4">
                        <h4 className="font-medium text-gray-900 text-sm mb-3">{runKey}</h4>
                        <div className="space-y-3">
                          {selectedNumbers.map((numId) => {
                            const numConfig = config.runKeys[runKey]?.numbers[numId] || { templateName: "", bodyParams: [], imageType: null };
                            const numName = config.numbers[numId]?.displayName || numId;
                            return (
                              <div key={numId} className="pl-3 border-l-2 border-gray-200">
                                <p className="text-xs text-gray-500 mb-1">{numName}</p>
                                <div className="flex gap-2 mb-2">
                                  <div className="flex-1 relative">
                                    <input
                                      type="text"
                                      placeholder="Search templates..."
                                      onChange={(e) => {
                                        // Store search per number+runkey
                                        const key = `${runKey}_${numId}`;
                                        (window as unknown as Record<string, string>)[`tplSearch_${key}`] = e.target.value;
                                        // Force re-render
                                        setTemplateSearch(e.target.value);
                                      }}
                                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs mb-1"
                                    />
                                    <select
                                      value={numConfig.templateName}
                                      onChange={(e) => {
                                        updateRunKeyTemplate(runKey, numId, "templateName", e.target.value);
                                        const tpl = (templates[numId] || []).find((t) => t.templateName === e.target.value);
                                        if (tpl) {
                                          const params = Array(tpl.parameterCount).fill("");
                                          updateRunKeyTemplate(runKey, numId, "bodyParams", params);
                                        }
                                      }}
                                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                                    >
                                      <option value="">Select template</option>
                                      {(templates[numId] || [])
                                        .filter((t) => t.templateName.toLowerCase().includes(templateSearch.toLowerCase()))
                                        .map((tpl) => (
                                        <option key={tpl.templateName} value={tpl.templateName}>
                                          {tpl.templateName} ({tpl.parameterCount}p)
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                                {/* Template preview */}
                                {numConfig.templateName && (() => {
                                  const tpl = (templates[numId] || []).find((t) => t.templateName === numConfig.templateName);
                                  const bodyText = tpl?.components?.find((c) => (c.type as string).toUpperCase() === "BODY")?.text;
                                  return bodyText ? (
                                    <div className="mb-2 p-2 bg-gray-50 rounded text-xs text-gray-600 whitespace-pre-wrap">{bodyText}</div>
                                  ) : null;
                                })()}
                                <div className="flex flex-wrap gap-1 items-center">
                                  {(numConfig.bodyParams || []).map((param, idx) => (
                                    <div key={idx} className="flex items-center gap-1">
                                      <select value={param} onChange={(e) => updateParam(runKey, numId, idx, e.target.value)} className="border border-gray-200 rounded px-1 py-0.5 text-xs">
                                        <option value="">--</option>
                                        <optgroup label="From DB">
                                          {DB_PARAMS.map((pk) => <option key={pk} value={pk}>{pk}</option>)}
                                        </optgroup>
                                        <optgroup label="Computed">
                                          {COMPUTED_PARAMS.map((pk) => <option key={pk} value={pk}>{pk}</option>)}
                                        </optgroup>
                                        {config && Object.keys(config.customParams || {}).length > 0 && (
                                          <optgroup label="Custom Static">
                                            {Object.keys(config.customParams || {}).map((pk) => <option key={pk} value={`__CUSTOM__${pk}`}>{pk} (static)</option>)}
                                          </optgroup>
                                        )}
                                      </select>
                                      <button onClick={() => removeParam(runKey, numId, idx)} className="text-red-400 hover:text-red-600"><Trash2 className="w-3 h-3" /></button>
                                    </div>
                                  ))}
                                  <button onClick={() => addParam(runKey, numId)} className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-0.5">
                                    <Plus className="w-3 h-3" /> param
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {toast && (
              <div className="fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg text-sm font-medium bg-green-600 text-white z-50">{toast}</div>
            )}
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
