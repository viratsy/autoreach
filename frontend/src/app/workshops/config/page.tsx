"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Save, Plus, Trash2, Search, ChevronDown, ChevronRight, Send } from "lucide-react";
import ImagePicker from "@/components/campaign/ImagePicker";

interface Business {
  businessId: string;
  businessName: string;
  phoneNumbers: { phoneNumberId: string; displayName: string; displayNumber: string }[];
}

interface NumberConfig {
  templateName: string;
  bodyParams: string[];
  imageType: string | null;
  headerImageUrl?: string;
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
  activeRunKeys?: string[];
}

interface TemplateItem {
  templateName: string;
  parameterCount: number;
  components: { type: string; text?: string }[];
  category?: string;
}

const DB_PARAMS = ["name", "zoom_link", "whatsapp_group", "workshop_name", "workshop_date", "workshop_time"];
const COMPUTED_PARAMS = ["full_workshop_name", "workshop_name_w", "workshop_date_time", "workshop_time_short", "mentor_name", "w_type", "w_name", "w_date", "three_hours_text", "duration"];
const DEFAULT_RUN_KEYS = [
  "2days_to_go", "1day_to_go", "9am_groupjoin", "1pm_group_join", "3pm_group_join",
  "60_mins_to_go", "20_mins_to_go", "we_are_live",
  "its_7_pm", "its_7_10_pm", "its_7_20_pm", "its_7_30_pm",
  "its_11_am", "its_11_10_am", "its_11_20_am", "its_11_30_am",
];

const SAMPLE_VALUES: Record<string, string> = {
  name: "Rahul", zoom_link: "https://zoom.us/j/123", whatsapp_group: "https://chat.whatsapp.com/abc",
  workshop_name: "AI Tools", workshop_date: "2026-06-05", workshop_time: "7:00 PM",
  full_workshop_name: "Generative AI Tools", workshop_name_w: "AI Tools Workshop",
  workshop_date_time: "5th June, 7:00 PM IST", workshop_time_short: "7 PM",
  mentor_name: "Hardik Raja (Your Mentor)", w_type: "Workshop", w_name: "AI Tools",
  three_hours_text: "3 hours live Generative AI Tools", duration: "7:00 PM to 10:00 PM IST", w_date: "5th June",
};

export default function WorkshopConfigPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [config, setConfig] = useState<WorkshopConfig | null>(null);
  const [wsCode, setWsCode] = useState("__DEFAULT__");
  const [cycle, setCycle] = useState(0);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [selectedNumbers, setSelectedNumbers] = useState<string[]>([]);
  const [templates, setTemplates] = useState<Record<string, TemplateItem[]>>({});
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(new Set(["2days_to_go"]));
  const [runKeyFilter, setRunKeyFilter] = useState("");
  const [tplSearches, setTplSearches] = useState<Record<string, string>>({});
  const [testPhone, setTestPhone] = useState("");
  const [testingKey, setTestingKey] = useState("");
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [showRunKeyPicker, setShowRunKeyPicker] = useState(false);
  const [defaultConfig, setDefaultConfig] = useState<WorkshopConfig | null>(null);
  const [registryWorkshops, setRegistryWorkshops] = useState<{ code: string; displayName: string; runKeys?: string[] }[]>([]);

  useEffect(() => { apiRequest<{ businesses: Business[] }>("/businesses").then((d) => setBusinesses(d.businesses)); }, []);
  useEffect(() => { loadConfig(); }, [wsCode, cycle]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3000); return () => clearTimeout(t); } }, [toast]);
  useEffect(() => {
    // Load default config
    apiRequest<{ config: WorkshopConfig | null }>(`/workshops/config?wsCode=__DEFAULT__&cycle=0`)
      .then((data) => { if (data.config) setDefaultConfig(data.config); })
      .catch(() => {});
    // Load registry
    apiRequest<{ workshops: { code: string; displayName: string; runKeys?: string[] }[] }>("/workshops/registry")
      .then((data) => setRegistryWorkshops(data.workshops))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (config?.businessId && selectedNumbers.length > 0) {
      const params = new URLSearchParams({ businessId: config.businessId, phoneNumberIds: selectedNumbers.join(",") });
      apiRequest<{ templates: (TemplateItem & { availableOn: string[] })[] }>(`/templates?${params}`)
        .then((data) => {
          const byNumber: Record<string, TemplateItem[]> = {};
          for (const tpl of data.templates) {
            for (const numId of tpl.availableOn) {
              if (!byNumber[numId]) byNumber[numId] = [];
              byNumber[numId].push({ templateName: tpl.templateName, parameterCount: tpl.parameterCount, components: tpl.components, category: tpl.category });
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
    try {
      await apiRequest("/workshops/config", { method: "PUT", body: JSON.stringify(config) });
      setToast("✓ Saved");
      // If saving default, update local default state
      if (wsCode === "__DEFAULT__") setDefaultConfig(config);
    }
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

  const toggleActiveRunKey = (rk: string) => {
    if (!config) return;
    const current = config.activeRunKeys || DEFAULT_RUN_KEYS;
    const updated = current.includes(rk) ? current.filter((k) => k !== rk) : [...current, rk];
    setConfig({ ...config, activeRunKeys: updated });
  };

  const initConfig = (businessId: string) => {
    setConfig({ wsCode, workshopName: wsCode, cycle, businessId, numbers: {}, runKeys: {}, customParams: {}, activeRunKeys: DEFAULT_RUN_KEYS });
  };

  const getParamSampleValue = (paramKey: string): string => {
    if (!paramKey) return "";
    const cleanKey = paramKey.startsWith("__CUSTOM__") ? paramKey.replace("__CUSTOM__", "") : paramKey;
    if (paramKey.startsWith("__CUSTOM__")) return (config?.customParams || {})[cleanKey] || `[${cleanKey}]`;
    return SAMPLE_VALUES[cleanKey] || `[${cleanKey}]`;
  };

  const handleTestSend = async (runKey: string, numId: string) => {
    if (!config || !testPhone) { setToast("Enter test phone number"); return; }
    const numConfig = config.runKeys[runKey]?.numbers[numId];
    if (!numConfig?.templateName) { setToast("No template selected"); return; }

    const resultKey = `${runKey}_${numId}`;
    setTestingKey(resultKey);

    // Build parameter values from sample data
    const parameterValues: Record<string, string> = {};
    (numConfig.bodyParams || []).forEach((p, i) => { parameterValues[String(i + 1)] = getParamSampleValue(p); });

    const biz = businesses.find((b) => b.businessId === config.businessId);
    const phoneNum = biz?.phoneNumbers.find((pn) => pn.phoneNumberId === numId);

    try {
      const res = await apiRequest<{ results: { status: string; error?: string }[] }>("/campaigns/test-send", {
        method: "POST",
        body: JSON.stringify({
          businessId: config.businessId,
          selectedNumbers: [{ phoneNumberId: numId, displayName: phoneNum?.displayName || numId }],
          templateName: numConfig.templateName,
          templateMappings: {},
          parameterValues,
          headerImageUrl: numConfig.headerImageUrl || "",
          numbersWithImageHeader: numConfig.headerImageUrl ? [numId] : [],
          testPhone: testPhone.startsWith("91") ? testPhone : `91${testPhone}`,
        }),
      });
      const r = res.results[0];
      setTestResults((prev) => ({ ...prev, [resultKey]: r.status === "sent" ? "✓ Sent" : `✗ ${r.error || "Failed"}` }));
      setToast(r.status === "sent" ? "✓ Test sent!" : `✗ ${r.error}`);
    } catch { setTestResults((prev) => ({ ...prev, [resultKey]: "✗ Error" })); setToast("✗ Test failed"); }
    finally { setTestingKey(""); }
  };

  const activeRunKeys = config?.activeRunKeys || registryWorkshops.find((w) => w.code === wsCode)?.runKeys || DEFAULT_RUN_KEYS;

  const copyParamsFromFirst = (runKey: string, targetNumId: string) => {
    if (!config) return;
    const firstNumId = selectedNumbers.find((nId) => nId !== targetNumId && config.runKeys[runKey]?.numbers[nId]?.bodyParams?.length > 0);
    if (!firstNumId) { setToast("No mapped params to copy from"); return; }
    const sourceParams = config.runKeys[runKey].numbers[firstNumId].bodyParams;
    updateRunKeyTemplate(runKey, targetNumId, "bodyParams", [...sourceParams]);
    setToast("✓ Params copied");
  };

  const copyFromDefault = (runKey: string, numId: string) => {
    if (!config || !defaultConfig) { setToast("No default config found"); return; }
    const defaultRunKey = defaultConfig.runKeys[runKey];
    if (!defaultRunKey) { setToast(`No default mapping for ${runKey}`); return; }
    // Find any number in default that has params (since params are same across numbers)
    const defaultNumIds = Object.keys(defaultRunKey.numbers || {});
    const sourceNumId = defaultNumIds.find((nId) => defaultRunKey.numbers[nId]?.bodyParams?.length > 0);
    if (!sourceNumId) { setToast("Default has no params for this run key"); return; }
    const sourceConfig = defaultRunKey.numbers[sourceNumId];
    // Copy params only (keep the number's own template)
    updateRunKeyTemplate(runKey, numId, "bodyParams", [...sourceConfig.bodyParams]);
    setToast("✓ Default params applied");
  };

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
              <div className="flex items-center gap-3">
                {/* Test phone input */}
                <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2 shadow-sm">
                  <Send className="w-3.5 h-3.5 text-gray-400" />
                  <input
                    type="text"
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value.replace(/\D/g, ""))}
                    placeholder="Test phone (91...)"
                    className="w-32 text-sm border-0 focus:ring-0 p-0 bg-transparent"
                  />
                </div>
                <button onClick={handleSave} disabled={saving || !config} className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-primary-700 shadow-sm">
                  <Save className="w-4 h-4" />
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            {/* Workshop + Cycle selector */}
            <div className="flex items-center gap-4 mb-6">
              <div className="relative">
                <button
                  onClick={() => setTplSearches((prev) => ({ ...prev, __ws_picker__: prev.__ws_picker__ ? "" : "1" }))}
                  className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm font-medium shadow-sm hover:border-gray-300 min-w-[160px]"
                >
                  <span className="flex-1 text-left">{wsCode === "__DEFAULT__" ? "⚙️ Default" : registryWorkshops.find((w) => w.code === wsCode)?.displayName || wsCode}</span>
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                </button>
                {tplSearches.__ws_picker__ && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
                    <button
                      onClick={() => { setWsCode("__DEFAULT__"); setTplSearches((prev) => ({ ...prev, __ws_picker__: "" })); }}
                      className={`w-full text-left px-4 py-2.5 text-sm hover:bg-primary-50 transition-colors ${wsCode === "__DEFAULT__" ? "bg-primary-50 text-primary-700 font-medium" : "text-gray-700"}`}
                    >⚙️ Default</button>
                    {registryWorkshops.map((ws) => (
                      <button
                        key={ws.code}
                        onClick={() => { setWsCode(ws.code); setTplSearches((prev) => ({ ...prev, __ws_picker__: "" })); }}
                        className={`w-full text-left px-4 py-2.5 text-sm hover:bg-primary-50 transition-colors border-t border-gray-50 ${wsCode === ws.code ? "bg-primary-50 text-primary-700 font-medium" : "text-gray-700"}`}
                      >{ws.displayName || ws.code}</button>
                    ))}
                  </div>
                )}
              </div>
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
                    <div className="flex flex-wrap gap-3">
                      <p className="text-sm text-gray-500 w-full mb-2">Select a business:</p>
                      {businesses.map((biz) => (
                        <button key={biz.businessId} onClick={() => setConfig({ ...config, businessId: biz.businessId })} className="px-4 py-2 bg-primary-50 text-primary-700 rounded-xl text-sm font-medium hover:bg-primary-100 border border-primary-200">
                          {biz.businessName}
                        </button>
                      ))}
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
                  )}
                </div>

                {/* Active Run Keys Picker */}
                {selectedNumbers.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Active Run Keys</h3>
                      <button onClick={() => setShowRunKeyPicker(!showRunKeyPicker)} className="text-xs text-primary-600 hover:text-primary-700 font-medium">
                        {showRunKeyPicker ? "Done" : `Edit (${activeRunKeys.length}/${DEFAULT_RUN_KEYS.length})`}
                      </button>
                    </div>
                    {showRunKeyPicker ? (
                      <div className="flex flex-wrap gap-2">
                        {DEFAULT_RUN_KEYS.map((rk) => (
                          <button key={rk} onClick={() => toggleActiveRunKey(rk)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${activeRunKeys.includes(rk) ? "bg-primary-100 text-primary-700 border border-primary-300" : "bg-gray-100 text-gray-400 border border-gray-200 line-through"}`}>
                            {rk}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {activeRunKeys.map((rk) => (
                          <span key={rk} className="px-2.5 py-1 bg-primary-50 text-primary-700 rounded-md text-xs font-medium">{rk}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Run Keys - Template Mapping */}
                {selectedNumbers.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Template Mapping</h3>
                        {defaultConfig && wsCode !== "__DEFAULT__" && (
                          <button
                            onClick={() => {
                              if (!config || !defaultConfig?.runKeys) return;
                              const newRunKeys = { ...config.runKeys };
                              for (const [rk, rkConfig] of Object.entries(defaultConfig.runKeys as Record<string, RunKeyConfig>)) {
                                if (!newRunKeys[rk]) newRunKeys[rk] = { numbers: {} };
                                const defaultNumEntries = Object.entries(rkConfig.numbers || {});
                                // Get default params from any number that has them
                                const defaultParams = defaultNumEntries.find(([, n]) => n.bodyParams?.length > 0)?.[1]?.bodyParams || [];
                                for (const numId of selectedNumbers) {
                                  if (!newRunKeys[rk].numbers[numId]) newRunKeys[rk].numbers[numId] = { templateName: "", bodyParams: [], imageType: null };
                                  const current = newRunKeys[rk].numbers[numId];
                                  // Copy template if same number exists in default and current has no template
                                  if (!current.templateName && rkConfig.numbers[numId]?.templateName) {
                                    current.templateName = rkConfig.numbers[numId].templateName;
                                  }
                                  // Copy params if current is empty
                                  if (!current.bodyParams?.length && defaultParams.length) {
                                    current.bodyParams = [...defaultParams];
                                  }
                                  newRunKeys[rk].numbers[numId] = { ...current };
                                }
                              }
                              setConfig({ ...config, runKeys: newRunKeys });
                              setToast("✓ Default templates & params applied");
                            }}
                            className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 border border-blue-200 transition-all"
                          >
                            Copy All from Default
                          </button>
                        )}
                      </div>
                      <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input type="text" value={runKeyFilter} onChange={(e) => setRunKeyFilter(e.target.value)} placeholder="Filter run keys..." className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm w-48" />
                      </div>
                    </div>

                    <div className="space-y-2">
                      {activeRunKeys.filter((rk) => rk.includes(runKeyFilter.toLowerCase())).map((runKey) => (
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
                                const testResultKey = `${runKey}_${numId}`;

                                return (
                                  <div key={numId} className="pl-4 border-l-3 border-primary-200">
                                    <div className="flex items-center justify-between mb-2">
                                      <p className="text-xs font-medium text-gray-600">{numName}</p>
                                      {numConfig.templateName && (
                                        <div className="flex items-center gap-2">
                                          {testResults[testResultKey] && (
                                            <span className={`text-[10px] font-medium ${testResults[testResultKey].startsWith("✓") ? "text-green-600" : "text-red-500"}`}>
                                              {testResults[testResultKey]}
                                            </span>
                                          )}
                                          {selectedNumbers.indexOf(numId) > 0 && (
                                            <button
                                              onClick={() => copyParamsFromFirst(runKey, numId)}
                                              className="px-2 py-1 text-[10px] font-medium bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 border border-gray-200 transition-all"
                                            >
                                              Copy params ↑
                                            </button>
                                          )}
                                          {defaultConfig && wsCode !== "__DEFAULT__" && (
                                            <button
                                              onClick={() => copyFromDefault(runKey, numId)}
                                              className="px-2 py-1 text-[10px] font-medium bg-blue-50 text-blue-600 rounded-md hover:bg-blue-100 border border-blue-200 transition-all"
                                            >
                                              Use Default
                                            </button>
                                          )}
                                          <button
                                            onClick={() => handleTestSend(runKey, numId)}
                                            disabled={testingKey === testResultKey || !testPhone}
                                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-emerald-50 text-emerald-700 rounded-md hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50 transition-all"
                                          >
                                            <Send className="w-2.5 h-2.5" />
                                            {testingKey === testResultKey ? "..." : "Test"}
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                    
                                    {/* Searchable template dropdown */}
                                    <div className="relative mb-2">
                                      <div className="relative">
                                        <input
                                          type="text"
                                          value={numConfig.templateName ? numConfig.templateName : tplSearch}
                                          onChange={(e) => {
                                            const val = e.target.value;
                                            if (numConfig.templateName) {
                                              updateRunKeyTemplate(runKey, numId, "templateName", "");
                                              setTplSearches((prev) => ({ ...prev, [searchKey]: val, [`${searchKey}_open`]: "1" }));
                                            } else {
                                              setTplSearches((prev) => ({ ...prev, [searchKey]: val, [`${searchKey}_open`]: "1" }));
                                            }
                                          }}
                                          onFocus={() => setTplSearches((prev) => ({ ...prev, [`${searchKey}_open`]: "1" }))}
                                          onBlur={() => setTimeout(() => setTplSearches((prev) => ({ ...prev, [`${searchKey}_open`]: "" })), 250)}
                                          placeholder="Search & select template..."
                                          className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent ${numConfig.templateName ? "border-primary-300 bg-primary-50 font-medium pr-16" : "border-gray-200"}`}
                                        />
                                        {numConfig.templateName && (() => {
                                          const selTpl = (templates[numId] || []).find((t) => t.templateName === numConfig.templateName);
                                          return selTpl?.category ? (
                                            <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${selTpl.category === "MARKETING" ? "bg-orange-100 text-orange-700" : "bg-green-100 text-green-700"}`}>
                                              {selTpl.category === "MARKETING" ? "MKT" : "UTL"}
                                            </span>
                                          ) : null;
                                        })()}
                                      </div>
                                      {tplSearches[`${searchKey}_open`] && !numConfig.templateName && (
                                        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-56 overflow-y-auto">
                                          {(templates[numId] || [])
                                            .filter((t) => t.templateName.includes((tplSearches[searchKey] || "").toLowerCase()))
                                            .map((tpl) => (
                                              <button
                                                key={tpl.templateName}
                                                onMouseDown={(e) => {
                                                  e.preventDefault();
                                                  updateRunKeyTemplate(runKey, numId, "templateName", tpl.templateName);
                                                  updateRunKeyTemplate(runKey, numId, "bodyParams", Array(tpl.parameterCount).fill(""));
                                                  setTplSearches((prev) => ({ ...prev, [searchKey]: "", [`${searchKey}_open`]: "" }));
                                                }}
                                                className="w-full text-left px-3 py-2.5 hover:bg-primary-50 transition-colors border-b border-gray-50 last:border-0 flex items-center justify-between"
                                              >
                                                <span>
                                                  <span className="text-sm text-gray-900">{tpl.templateName}</span>
                                                  <span className="text-xs text-gray-400 ml-2">({tpl.parameterCount}p)</span>
                                                </span>
                                                {tpl.category && (
                                                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${tpl.category === "MARKETING" ? "bg-orange-100 text-orange-700" : "bg-green-100 text-green-700"}`}>
                                                    {tpl.category === "MARKETING" ? "MKT" : "UTL"}
                                                  </span>
                                                )}
                                              </button>
                                            ))}
                                          {(templates[numId] || []).filter((t) => t.templateName.includes((tplSearches[searchKey] || "").toLowerCase())).length === 0 && (
                                            <p className="px-3 py-3 text-xs text-gray-400 text-center">No templates found</p>
                                          )}
                                        </div>
                                      )}
                                    </div>

                                    {/* Image Header picker - show when template has IMAGE header */}
                                    {numConfig.templateName && (() => {
                                      const tpl = (templates[numId] || []).find((t) => t.templateName === numConfig.templateName);
                                      const hasImageHeader = tpl?.components?.some((c) => (c.type as string).toUpperCase() === "HEADER");
                                      if (!hasImageHeader) return null;
                                      return (
                                        <div className="mb-3">
                                          <p className="text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">Header Image</p>
                                          <ImagePicker
                                            value={numConfig.headerImageUrl || ""}
                                            onChange={(url) => updateRunKeyTemplate(runKey, numId, "headerImageUrl", url)}
                                          />
                                        </div>
                                      );
                                    })()}

                                    {/* Template body preview with sample data */}
                                    {numConfig.templateName && (() => {
                                      const tpl = (templates[numId] || []).find((t) => t.templateName === numConfig.templateName);
                                      const bodyText = tpl?.components?.find((c) => (c.type as string).toUpperCase() === "BODY")?.text;
                                      if (!bodyText) return null;
                                      const previewText = bodyText.replace(/\{\{(\d+)\}\}/g, (_, num) => {
                                        const idx = parseInt(num) - 1;
                                        const paramKey = (numConfig.bodyParams || [])[idx];
                                        if (!paramKey) return `[param ${num}]`;
                                        return getParamSampleValue(paramKey);
                                      });
                                      return (
                                        <div className="mb-3 p-3 bg-gradient-to-r from-slate-50 to-gray-50 rounded-lg text-xs text-gray-600 whitespace-pre-wrap border border-gray-100 leading-relaxed">
                                          {previewText}
                                        </div>
                                      );
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
                                                  const val = e.target.value;
                                                  if (param) {
                                                    const p = [...(numConfig.bodyParams || [])]; p[idx] = "";
                                                    updateRunKeyTemplate(runKey, numId, "bodyParams", p);
                                                    setTplSearches((prev) => ({ ...prev, [paramSearchKey]: val, [`${paramSearchKey}_open`]: "1" }));
                                                  } else {
                                                    setTplSearches((prev) => ({ ...prev, [paramSearchKey]: val, [`${paramSearchKey}_open`]: "1" }));
                                                  }
                                                }}
                                                onFocus={() => setTplSearches((prev) => ({ ...prev, [`${paramSearchKey}_open`]: "1" }))}
                                                onBlur={() => setTimeout(() => setTplSearches((prev) => ({ ...prev, [`${paramSearchKey}_open`]: "" })), 250)}
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
                                                      setTplSearches((prev) => ({ ...prev, [paramSearchKey]: "", [`${paramSearchKey}_open`]: "" }));
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
