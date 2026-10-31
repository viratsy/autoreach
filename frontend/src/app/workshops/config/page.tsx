"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Save, Plus, Trash2, X, Search, ChevronDown, ChevronRight, Send, RefreshCw, Users } from "lucide-react";
import ImagePicker from "@/components/campaign/ImagePicker";
import TimePicker12h from "@/components/campaign/TimePicker12h";
import { inferRunKeyOffset, toSignedMinutes } from "@/lib/runKeyOffset";

interface Business {
  businessId: string;
  businessName: string;
  phoneNumbers: { phoneNumberId: string; displayName: string; displayNumber: string }[];
}

// One shared template + param set per run key — not per number. Params
// (workshop_date, zoom_link, ...) and the template name are the same
// message content regardless of which of the (potentially hundreds of)
// sending numbers delivers it. The only thing that legitimately varies per
// number is template approval status, which is looked up live from the
// templates table (availableOn) rather than stored here.
interface RunKeyConfig {
  templateName: string;
  bodyParams: string[];
  headerImageUrl?: string;
  // How long before the (promoted) workshop date/time this run key's message
  // should go out — e.g. "2days_to_go" implies 2880. Used by Crossale to
  // auto-schedule; saved here so it's remembered for next time rather than
  // re-entered on every crosssale. Absent/0 means "at the workshop time".
  offsetMinutes?: number;
}

// Old per-number shape, kept only so loadConfig can recognize and collapse
// configs saved before this redesign.
interface LegacyNumberConfig {
  templateName: string;
  bodyParams: string[];
  headerImageUrl?: string;
}
interface LegacyRunKeyConfig {
  numbers: Record<string, LegacyNumberConfig>;
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
  components: { type: string; text?: string; format?: string }[];
  category?: string;
  // Category is approved per number, same as template availability itself —
  // a template can be UTILITY on one WABA and MARKETING on another. The
  // single `category` field is just "MARKETING if any number has it that
  // way", which tells you it's mixed but not which numbers.
  categoryPerNumber?: Record<string, string>;
  // Structure is per-number too, not just category: the same template name can
  // carry an IMAGE header on some numbers and none on others. Sending a header
  // image to a number whose copy has no header slot is rejected outright by
  // Meta, so this is what decides whether an image is asked for at all.
  hasImageHeaderPerNumber?: Record<string, boolean>;
  availableOn: string[];
}

const DB_PARAMS = ["name", "zoom_link", "whatsapp_group", "workshop_name", "workshop_date", "workshop_time"];
const COMPUTED_PARAMS = ["full_workshop_name", "workshop_name_w", "workshop_date_time", "workshop_time_short", "mentor_name", "w_type", "w_name", "w_date", "three_hours_text", "duration"];
const DEFAULT_RUN_KEYS = [
  "2days_to_go", "1day_to_go", "9am_groupjoin", "1pm_group_join", "3pm_group_join",
  "60_mins_to_go", "20_mins_to_go", "we_are_live",
  "its_7_pm", "its_7_10_pm", "its_7_20_pm", "its_7_30_pm",
  "its_11_am", "its_11_10_am", "its_11_20_am", "its_11_30_am",
];

// "7pm" / "11:30am" -> "19:00" / "11:30". Falls back to 7pm, the most common
// workshop start, when the registry's label doesn't parse.
function parseTimeLabelToHHMM(label?: string): string {
  const m = (label || "").match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return "19:00";
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const isPM = (m[3] || "").toLowerCase() === "pm";
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
function formatHHMMTo12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}
// A signed offsetMinutes (the only thing actually stored/sent to the
// backend — sendMoment = workshopStart - offsetMinutes) decomposed into
// what a human actually thinks in: "N days before/after, at HH:MM" — e.g.
// "2 days before, at 9:00 AM" instead of a raw "2880 minutes before" that
// forces mental math to see what clock time that lands on. daysOffset is
// always 0 for same-day run keys (its_7_10_pm, we_are_live, ...); the exact
// clock time on that day is what actually distinguishes before/after start
// for those, so the before/after direction is only meaningful once
// daysOffset > 0.
interface DecomposedOffset {
  daysOffset: number;
  direction: "before" | "after";
  timeOfDayHHMM: string;
}
function decomposeOffset(signedOffsetMinutes: number, workshopTimeHHMM: string): DecomposedOffset {
  const [wh, wm] = workshopTimeHHMM.split(":").map(Number);
  const workshopMinutes = wh * 60 + wm;
  const sendMinutesFromWorkshopMidnight = workshopMinutes - signedOffsetMinutes;
  const dayIndex = Math.floor(sendMinutesFromWorkshopMidnight / 1440);
  const timeOfDayMinutes = ((sendMinutesFromWorkshopMidnight % 1440) + 1440) % 1440;
  const hh = Math.floor(timeOfDayMinutes / 60);
  const mm = timeOfDayMinutes % 60;
  return {
    daysOffset: Math.abs(dayIndex),
    direction: dayIndex <= 0 ? "before" : "after",
    timeOfDayHHMM: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
  };
}
function composeOffset(daysOffset: number, direction: "before" | "after", timeOfDayHHMM: string, workshopTimeHHMM: string): number {
  const [wh, wm] = workshopTimeHHMM.split(":").map(Number);
  const [th, tm] = timeOfDayHHMM.split(":").map(Number);
  const clockDiff = (wh * 60 + wm) - (th * 60 + tm);
  const daysComponent = direction === "before" ? daysOffset * 1440 : -daysOffset * 1440;
  return daysComponent + clockDiff;
}

const SAMPLE_VALUES: Record<string, string> = {
  name: "Rahul", zoom_link: "https://zoom.us/j/123", whatsapp_group: "https://chat.whatsapp.com/abc",
  workshop_name: "AI Tools", workshop_date: "2026-06-05", workshop_time: "7:00 PM",
  full_workshop_name: "Generative AI Tools", workshop_name_w: "AI Tools Workshop",
  workshop_date_time: "5th June, 7:00 PM IST", workshop_time_short: "7 PM",
  mentor_name: "Hardik Raja (Your Mentor)", w_type: "Workshop", w_name: "AI Tools",
  three_hours_text: "3 hours live Generative AI Tools", duration: "7:00 PM to 10:00 PM IST", w_date: "5th June",
};

// A config saved before this redesign has `runKeys[rk].numbers` instead of
// a flat `runKeys[rk].templateName`. Collapse it once on load — every
// number's mapping was already meant to be identical (that's what "Copy
// params", "Use Default" etc. were working around), so this just picks
// the first non-empty one as the canonical shared value. Re-saving writes
// the new flat shape, so this only ever runs once per config.
function migrateRunKeys(raw: Record<string, RunKeyConfig | LegacyRunKeyConfig> | undefined): Record<string, RunKeyConfig> {
  const migrated: Record<string, RunKeyConfig> = {};
  for (const [rk, rkConfig] of Object.entries(raw || {})) {
    if (rkConfig && "numbers" in rkConfig) {
      const withTemplate = Object.values(rkConfig.numbers || {}).find((n) => n?.templateName);
      migrated[rk] = withTemplate
        ? { templateName: withTemplate.templateName, bodyParams: withTemplate.bodyParams || [], headerImageUrl: withTemplate.headerImageUrl || "" }
        : { templateName: "", bodyParams: [], headerImageUrl: "" };
    } else {
      const flat = rkConfig as RunKeyConfig | undefined;
      migrated[rk] = { templateName: flat?.templateName || "", bodyParams: flat?.bodyParams || [], headerImageUrl: flat?.headerImageUrl || "", offsetMinutes: flat?.offsetMinutes };
    }
  }
  return migrated;
}

export default function WorkshopConfigPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [config, setConfig] = useState<WorkshopConfig | null>(null);
  const [wsCode, setWsCode] = useState("");
  // Cycles 1-4 belonged to the old automatic counter-based re-engagement
  // system, which is being replaced by manual, one-off sends — there's
  // never a reason to configure anything beyond the current cycle now.
  const cycle = 0;
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [selectedNumbers, setSelectedNumbers] = useState<string[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(new Set(["2days_to_go"]));
  const [runKeyFilter, setRunKeyFilter] = useState("");
  const [tplSearches, setTplSearches] = useState<Record<string, string>>({});
  const [testPhone, setTestPhone] = useState("");
  const [testingKey, setTestingKey] = useState("");
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [registryWorkshops, setRegistryWorkshops] = useState<{ code: string; displayName: string; runKeys?: string[]; time?: string }[]>([]);
  // Reference "workshop starts at" clock time, purely for computing the
  // clock-time preview next to each run key below — Workshop Config is the
  // standing template for a recurring workshop, not tied to one specific
  // date/batch, so there's no real "start time" to read off a campaign.
  // Defaults from the registry's coarse time label (e.g. "7pm" -> "19:00"),
  // editable here since that label alone isn't precise to the minute.
  const [workshopTimeHHMM, setWorkshopTimeHHMM] = useState("19:00");
  const [newRunKeyName, setNewRunKeyName] = useState("");

  useEffect(() => { apiRequest<{ businesses: Business[] }>("/businesses").then((d) => setBusinesses(d.businesses)); }, []);
  useEffect(() => { loadConfig(); }, [wsCode, cycle]);
  useEffect(() => {
    const label = registryWorkshops.find((w) => w.code === wsCode)?.time;
    setWorkshopTimeHHMM(parseTimeLabelToHHMM(label));
  }, [wsCode, registryWorkshops]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3000); return () => clearTimeout(t); } }, [toast]);
  useEffect(() => {
    // Load registry
    apiRequest<{ workshops: { code: string; displayName: string; runKeys?: string[]; time?: string }[] }>("/workshops/registry")
      .then((data) => setRegistryWorkshops(data.workshops))
      .catch(() => {});
  }, []);

  const loadTemplates = async () => {
    if (!config?.businessId || selectedNumbers.length === 0) return;
    setLoadingTemplates(true);
    const params = new URLSearchParams({ businessId: config.businessId, phoneNumberIds: selectedNumbers.join(",") });
    try {
      const data = await apiRequest<{ templates: TemplateItem[] }>(`/templates?${params}`);
      setTemplates([...data.templates].sort((a, b) => a.templateName.localeCompare(b.templateName)));
      setToast("✓ Templates synced");
    } catch {
      setTemplates([]);
    } finally {
      setLoadingTemplates(false);
    }
  };

  useEffect(() => {
    if (config?.businessId && selectedNumbers.length > 0) {
      loadTemplates();
    }
  }, [config?.businessId, selectedNumbers]);

  const loadConfig = async () => {
    try {
      const data = await apiRequest<{ config: (WorkshopConfig & { runKeys: Record<string, RunKeyConfig | LegacyRunKeyConfig> }) | null }>(`/workshops/config?wsCode=${wsCode}&cycle=${cycle}`);
      if (data.config) {
        setConfig({ ...data.config, runKeys: migrateRunKeys(data.config.runKeys) });
        setSelectedNumbers(Object.keys(data.config.numbers || {}));
      } else { setConfig(null); setSelectedNumbers([]); }
    } catch { setConfig(null); }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await apiRequest("/workshops/config", { method: "PUT", body: JSON.stringify(config) });
      setToast("✓ Saved");
      // If saving default, update local default state
    }
    catch { setToast("✗ Failed"); }
    finally { setSaving(false); }
  };

  // Wipes sending numbers and every run key's template mapping for this
  // workshop+cycle, then saves immediately — a genuine start-over, not just
  // a local form clear, since the whole point is undoing a saved config
  // that's wrong rather than one still being drafted.
  const handleReset = async () => {
    if (!config) return;
    setShowResetConfirm(false);
    // Clearing businessId too, not just numbers/runKeys — otherwise reset
    // silently keeps whatever business this workshop happened to be wired
    // to, which is exactly the kind of stale/wrong assignment a "start
    // over" is meant to catch (e.g. a workshop pointing at the wrong
    // business entirely). Matches the true blank "no config exists" state.
    const resetConfig: WorkshopConfig = { ...config, businessId: "", numbers: {}, runKeys: {} };
    setSaving(true);
    try {
      await apiRequest("/workshops/config", { method: "PUT", body: JSON.stringify(resetConfig) });
      setConfig(resetConfig);
      setSelectedNumbers([]);
      setExpandedRunKeys(new Set());
      setTestResults({});
      setTemplates([]);
      setToast("✓ Reset");
    } catch {
      setToast("✗ Reset failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleNumber = (phoneNumberId: string, displayName: string) => {
    if (!config) return;
    const newNumbers = { ...config.numbers };
    if (newNumbers[phoneNumberId]) {
      delete newNumbers[phoneNumberId];
    } else {
      newNumbers[phoneNumberId] = { displayName };
    }
    setConfig({ ...config, numbers: newNumbers });
    setSelectedNumbers(Object.keys(newNumbers));
  };

  const updateRunKey = (runKey: string, field: keyof RunKeyConfig, value: unknown) => {
    // Functional form is required here, not optional style — selecting a
    // template calls this twice in a row synchronously (templateName, then
    // bodyParams). With a closed-over `config`, the second call would still
    // see the pre-first-update state and silently discard the templateName
    // that was just set, since React batches both setState calls before
    // re-rendering. `prev` always reflects whichever update is truly latest.
    setConfig((prev) => {
      if (!prev) return prev;
      const current = prev.runKeys[runKey] || { templateName: "", bodyParams: [], headerImageUrl: "" };
      return { ...prev, runKeys: { ...prev.runKeys, [runKey]: { ...current, [field]: value } } };
    });
  };

  const toggleRunKey = (rk: string) => {
    const s = new Set(expandedRunKeys);
    s.has(rk) ? s.delete(rk) : s.add(rk);
    setExpandedRunKeys(s);
  };

  // Not restricted to DEFAULT_RUN_KEYS — a workshop can need a reminder slot
  // the standard set doesn't cover (e.g. a one-off timing). Adding one just
  // extends activeRunKeys; it shows up in Template Mapping below like any
  // other run key, ready to configure.
  const addRunKey = () => {
    if (!config) return;
    const rk = newRunKeyName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!rk) return;
    const current = config.activeRunKeys || DEFAULT_RUN_KEYS;
    if (current.includes(rk)) { setToast(`"${rk}" already exists`); return; }
    setConfig({ ...config, activeRunKeys: [...current, rk] });
    setNewRunKeyName("");
    setExpandedRunKeys((prev) => new Set(prev).add(rk));
  };

  // Unlike toggling a DEFAULT_RUN_KEYS entry off (which just hides it while
  // keeping its template mapping so re-enabling restores it), this is a real
  // delete: the run key drops out of activeRunKeys AND its saved template/
  // params are discarded — the only way to fully remove a custom run key,
  // since those never appear in the DEFAULT_RUN_KEYS toggle grid at all.
  const deleteRunKey = (rk: string) => {
    if (!config) return;
    const current = config.activeRunKeys || DEFAULT_RUN_KEYS;
    const newRunKeys = { ...config.runKeys };
    delete newRunKeys[rk];
    setConfig({ ...config, activeRunKeys: current.filter((k) => k !== rk), runKeys: newRunKeys });
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

  const handleTestSend = async (runKey: string) => {
    if (!config || !testPhone) { setToast("Enter test phone number"); return; }
    const rk = config.runKeys[runKey];
    if (!rk?.templateName) { setToast("No template selected"); return; }

    const tpl = templates.find((t) => t.templateName === rk.templateName);
    const targetNumId = selectedNumbers.find((id) => tpl?.availableOn.includes(id));
    if (!targetNumId) { setToast("No sending number has this template approved yet"); return; }

    setTestingKey(runKey);

    const parameterValues: Record<string, string> = {};
    (rk.bodyParams || []).forEach((p, i) => { parameterValues[String(i + 1)] = getParamSampleValue(p); });

    const biz = businesses.find((b) => b.businessId === config.businessId);
    const phoneNum = biz?.phoneNumbers.find((pn) => pn.phoneNumberId === targetNumId);

    try {
      const res = await apiRequest<{ results: { status: string; error?: string }[] }>("/campaigns/test-send", {
        method: "POST",
        body: JSON.stringify({
          businessId: config.businessId,
          selectedNumbers: [{ phoneNumberId: targetNumId, displayName: phoneNum?.displayName || targetNumId }],
          templateName: rk.templateName,
          templateMappings: {},
          parameterValues,
          headerImageUrl: rk.headerImageUrl || "",
          numbersWithImageHeader: rk.headerImageUrl ? [targetNumId] : [],
          testPhone: testPhone.startsWith("91") ? testPhone : `91${testPhone}`,
        }),
      });
      const r = res.results[0];
      setTestResults((prev) => ({ ...prev, [runKey]: r.status === "sent" ? "✓ Sent" : `✗ ${r.error || "Failed"}` }));
      setToast(r.status === "sent" ? "✓ Test sent!" : `✗ ${r.error}`);
    } catch { setTestResults((prev) => ({ ...prev, [runKey]: "✗ Error" })); setToast("✗ Test failed"); }
    finally { setTestingKey(""); }
  };

  const activeRunKeys = config?.activeRunKeys || registryWorkshops.find((w) => w.code === wsCode)?.runKeys || DEFAULT_RUN_KEYS;

  // displayName alone is useless for telling numbers apart — nearly every
  // number here is named "Hardik Raja", so a missing-numbers list built from
  // just that collapses into an unreadable wall of repeated names. Always
  // pair it with the actual phone number.
  const getNumberLabel = (id: string): string => {
    const biz = businesses.find((b) => b.businessId === config?.businessId);
    const pn = biz?.phoneNumbers.find((p) => p.phoneNumberId === id);
    const name = pn?.displayName || config?.numbers[id]?.displayName || id;
    return pn?.displayNumber ? `${name} (${pn.displayNumber})` : name;
  };

  return (
    <AuthGuard>
      <AppShell mainClassName="flex-1 overflow-y-auto p-4 pt-20 md:p-6 bg-gray-50">
          <div className="max-w-4xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Workshop Config</h2>
                <p className="text-sm text-gray-500 mt-1">One template + parameters per run key, shared across every sending number.</p>
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
                {config && (Object.keys(config.numbers).length > 0 || Object.keys(config.runKeys).length > 0) && (
                  <div className="relative">
                    <button
                      onClick={() => setShowResetConfirm((v) => !v)}
                      disabled={saving}
                      title="Clear sending numbers and template mappings for this workshop"
                      className="flex items-center gap-2 px-4 py-2.5 text-red-600 rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-red-50 border border-red-200"
                    >
                      <Trash2 className="w-4 h-4" />
                      Reset
                    </button>
                    {showResetConfirm && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowResetConfirm(false)} />
                        <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-20 p-3 text-sm">
                          <p className="text-gray-700 mb-3">
                            This clears every sending number and run-key template mapping for{" "}
                            <span className="font-medium">
                              {registryWorkshops.find((w) => w.code === wsCode)?.displayName || wsCode}
                            </span>{" "}
                            and saves immediately. This can&apos;t be undone.
                          </p>
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setShowResetConfirm(false)} className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1">
                              Cancel
                            </button>
                            <button onClick={handleReset} className="text-xs bg-red-600 hover:bg-red-700 text-white font-medium px-3 py-1.5 rounded-md">
                              Yes, reset
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
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
                  <span className="flex-1 text-left">{registryWorkshops.find((w) => w.code === wsCode)?.displayName || wsCode || "Select workshop"}</span>
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                </button>
                {tplSearches.__ws_picker__ && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
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
            </div>

            {!config ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center shadow-sm">
                <p className="text-gray-500 mb-6">No config exists for <span className="font-medium">{wsCode}</span></p>
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
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Sending Numbers</h3>
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5 text-xs text-gray-400">
                        <Users className="w-3.5 h-3.5" />
                        {selectedNumbers.length} selected
                      </span>
                      {config.businessId && (() => {
                        const allNumbers = businesses.find((b) => b.businessId === config.businessId)?.phoneNumbers || [];
                        const allSelected = allNumbers.length > 0 && allNumbers.every((pn) => selectedNumbers.includes(pn.phoneNumberId));
                        return (
                          <button
                            onClick={() => {
                              const newNumbers = allSelected
                                ? {}
                                : Object.fromEntries(allNumbers.map((pn) => [pn.phoneNumberId, { displayName: pn.displayName }]));
                              setConfig({ ...config, numbers: newNumbers });
                              setSelectedNumbers(Object.keys(newNumbers));
                            }}
                            className="text-xs font-medium text-primary-600 hover:text-primary-700"
                          >
                            {allSelected ? "Deselect All" : "Select All"}
                          </button>
                        );
                      })()}
                    </div>
                  </div>
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

                {/* Workshop Run Keys — one row per run key: its name and the
                    expected send time together, since "what fires and when"
                    is one decision, not two separate UIs (a toggle grid that
                    hid timing entirely, plus a duplicate time editor buried
                    inside each row's expanded Template Mapping accordion). */}
                {selectedNumbers.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Workshop Run Keys</h3>
                      <span className="text-xs text-gray-400">{activeRunKeys.length} run key{activeRunKeys.length !== 1 ? "s" : ""}</span>
                    </div>
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xs text-gray-500">Workshop starts at</span>
                      <TimePicker12h
                        value={workshopTimeHHMM}
                        onChange={setWorkshopTimeHHMM}
                        className="text-xs"
                      />
                      <span className="text-xs text-gray-400">— used below to show each run key&apos;s actual clock time (not saved, just a reference for this screen)</span>
                    </div>
                    <div className="space-y-1.5">
                      {activeRunKeys.map((runKey) => {
                        const rk = config.runKeys[runKey] || { templateName: "", bodyParams: [], headerImageUrl: "" };
                        const saved = rk.offsetMinutes;
                        // Nobody's manually set most run keys' timing — infer a sensible
                        // default from the name (e.g. "9am_groupjoin" -> 9:00 AM) instead
                        // of showing everything as a meaningless "0 days before start".
                        const inferred = saved === undefined || saved === null ? inferRunKeyOffset(runKey, workshopTimeHHMM) : null;
                        const effectiveOffset = saved ?? (inferred ? toSignedMinutes(inferred.minutes, inferred.direction) : 0);
                        const { daysOffset, direction, timeOfDayHHMM } = decomposeOffset(effectiveOffset, workshopTimeHHMM);
                        const setDays = (n: number) => updateRunKey(runKey, "offsetMinutes", composeOffset(Math.max(0, n), direction, timeOfDayHHMM, workshopTimeHHMM));
                        const setDirection = (d: "before" | "after") => updateRunKey(runKey, "offsetMinutes", composeOffset(daysOffset, d, timeOfDayHHMM, workshopTimeHHMM));
                        const setTimeOfDay = (hhmm: string) => updateRunKey(runKey, "offsetMinutes", composeOffset(daysOffset, direction, hhmm, workshopTimeHHMM));
                        return (
                          <div key={runKey} className="flex items-center gap-2 px-3 py-2 border border-gray-100 rounded-lg flex-wrap">
                            <span className="flex-1 min-w-[120px] text-sm font-medium text-gray-900 font-mono truncate">{runKey}</span>
                            <span className="text-xs text-gray-400">Send</span>
                            <input
                              type="number"
                              min={0}
                              value={daysOffset}
                              onChange={(e) => setDays(Number(e.target.value) || 0)}
                              className="w-14 border border-gray-200 rounded-lg px-2 py-1 text-xs"
                            />
                            <span className="text-xs text-gray-500">day{daysOffset === 1 ? "" : "s"}</span>
                            <select
                              value={direction}
                              onChange={(e) => setDirection(e.target.value as "before" | "after")}
                              disabled={daysOffset === 0}
                              className="border border-gray-200 rounded-lg px-2 py-1 text-xs disabled:opacity-40"
                            >
                              <option value="before">before start</option>
                              <option value="after">after start</option>
                            </select>
                            <span className="text-xs text-gray-500">at</span>
                            <TimePicker12h
                              value={timeOfDayHHMM}
                              onChange={setTimeOfDay}
                              className="text-xs"
                            />
                            <span className={`text-xs font-medium ${saved == null ? "text-gray-400 italic" : "text-primary-600"}`} title={saved == null ? "Inferred from the run key name — not saved yet" : "Explicitly set"}>
                              {formatHHMMTo12h(timeOfDayHHMM)}{saved == null ? " (inferred)" : ""}
                            </span>
                            <button onClick={() => deleteRunKey(runKey)} className="text-gray-300 hover:text-red-500 p-1 ml-auto" title="Delete run key">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
                      <input
                        type="text"
                        list="default-run-key-suggestions"
                        value={newRunKeyName}
                        onChange={(e) => setNewRunKeyName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addRunKey(); }}
                        placeholder="New run key name (e.g. 6_50_pm_live)"
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-xs"
                      />
                      <datalist id="default-run-key-suggestions">
                        {DEFAULT_RUN_KEYS.filter((rk) => !activeRunKeys.includes(rk)).map((rk) => <option key={rk} value={rk} />)}
                      </datalist>
                      <button onClick={addRunKey} disabled={!newRunKeyName.trim()} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-primary-50 text-primary-700 rounded-lg hover:bg-primary-100 border border-primary-200 disabled:opacity-50">
                        <Plus className="w-3 h-3" /> Add Run Key
                      </button>
                    </div>
                  </div>
                )}

                {/* Run Keys - Template Mapping */}
                {selectedNumbers.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Template Mapping</h3>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => loadTemplates()} disabled={loadingTemplates} className="flex items-center gap-1 px-3 py-2 text-xs font-medium text-primary-600 hover:text-primary-700 hover:bg-primary-50 rounded-lg border border-primary-200 transition-all disabled:opacity-50">
                          <RefreshCw className={`w-3 h-3 ${loadingTemplates ? "animate-spin" : ""}`} /> Sync Templates
                        </button>
                        <div className="relative">
                          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                          <input type="text" value={runKeyFilter} onChange={(e) => setRunKeyFilter(e.target.value)} placeholder="Filter run keys..." className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm w-48" />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {activeRunKeys.filter((rk) => rk.includes(runKeyFilter.toLowerCase())).map((runKey) => {
                        const rk = config.runKeys[runKey] || { templateName: "", bodyParams: [], headerImageUrl: "" };
                        const selTpl = templates.find((t) => t.templateName === rk.templateName);
                        const searchKey = `tpl_${runKey}`;
                        const tplSearch = tplSearches[searchKey] || "";
                        const availableCount = selTpl ? selectedNumbers.filter((id) => selTpl.availableOn.includes(id)).length : 0;
                        const missingNumbers = selTpl ? selectedNumbers.filter((id) => !selTpl.availableOn.includes(id)) : [];
                        // Category, like approval, is per-number — the same
                        // template can be MARKETING on one WABA and UTILITY
                        // on another. `selTpl.category` only tells you "at
                        // least one number has it as MARKETING", not which.
                        const marketingNumbers = selTpl
                          ? selectedNumbers.filter((id) => selTpl.availableOn.includes(id) && selTpl.categoryPerNumber?.[id] === "MARKETING")
                          : [];
                        const categoryMixed = selTpl && marketingNumbers.length > 0 && marketingNumbers.length < availableCount;
                        // Which numbers actually take a header image. Read per
                        // number rather than off selTpl.components, which is
                        // only ever one number's copy of the template.
                        const imageHeaderNumbers = selTpl
                          ? selectedNumbers.filter((id) => selTpl.availableOn.includes(id) && selTpl.hasImageHeaderPerNumber?.[id] === true)
                          : [];
                        const headerMixed = imageHeaderNumbers.length > 0 && imageHeaderNumbers.length < availableCount;
                        const needsImage = imageHeaderNumbers.length > 0 && !rk.headerImageUrl;

                        return (
                          <div key={runKey} className="border border-gray-100 rounded-xl">
                            <button onClick={() => toggleRunKey(runKey)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-gray-900">{runKey}</span>
                                {rk.templateName && (
                                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded font-mono">{rk.templateName}</span>
                                )}
                              </div>
                              {expandedRunKeys.has(runKey) ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                            </button>

                            {expandedRunKeys.has(runKey) && (
                              <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3 overflow-visible">
                                <div className="flex items-center justify-between">
                                  <p className="text-xs font-medium text-gray-600">Template (used by all {selectedNumbers.length} sending numbers)</p>
                                  {rk.templateName && (
                                    <div className="flex items-center gap-2">
                                      {testResults[runKey] && (
                                        <span className={`text-[10px] font-medium ${testResults[runKey].startsWith("✓") ? "text-green-600" : "text-red-500"}`}>
                                          {testResults[runKey]}
                                        </span>
                                      )}
                                      <button
                                        onClick={() => handleTestSend(runKey)}
                                        disabled={testingKey === runKey || !testPhone || availableCount === 0}
                                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-emerald-50 text-emerald-700 rounded-md hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50 transition-all"
                                      >
                                        <Send className="w-2.5 h-2.5" />
                                        {testingKey === runKey ? "..." : "Test"}
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {/* Searchable template dropdown */}
                                <div className="relative">
                                  <div className="relative">
                                    <input
                                      type="text"
                                      value={rk.templateName ? rk.templateName : tplSearch}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        if (rk.templateName) updateRunKey(runKey, "templateName", "");
                                        setTplSearches((prev) => ({ ...prev, [searchKey]: val, [`${searchKey}_open`]: "1" }));
                                      }}
                                      onFocus={() => setTplSearches((prev) => ({ ...prev, [`${searchKey}_open`]: "1" }))}
                                      onBlur={() => setTimeout(() => setTplSearches((prev) => ({ ...prev, [`${searchKey}_open`]: "" })), 250)}
                                      placeholder="Search & select template..."
                                      className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent ${rk.templateName ? "border-primary-300 bg-primary-50 font-medium pr-16" : "border-gray-200"}`}
                                    />
                                    {rk.templateName && selTpl?.category && (
                                      <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${categoryMixed ? "bg-amber-100 text-amber-700" : selTpl.category === "MARKETING" ? "bg-orange-100 text-orange-700" : "bg-green-100 text-green-700"}`}>
                                        {categoryMixed ? "MIXED" : selTpl.category === "MARKETING" ? "MKT" : "UTL"}
                                      </span>
                                    )}
                                  </div>
                                  {tplSearches[`${searchKey}_open`] && !rk.templateName && (
                                    <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-56 overflow-y-auto">
                                      {templates
                                        .filter((t) => t.templateName.includes(tplSearch.toLowerCase()))
                                        .map((tpl) => (
                                          <button
                                            key={tpl.templateName}
                                            onMouseDown={(e) => {
                                              e.preventDefault();
                                              updateRunKey(runKey, "templateName", tpl.templateName);
                                              updateRunKey(runKey, "bodyParams", Array(tpl.parameterCount).fill(""));
                                              setTplSearches((prev) => ({ ...prev, [searchKey]: "", [`${searchKey}_open`]: "" }));
                                            }}
                                            className="w-full text-left px-3 py-2.5 hover:bg-primary-50 transition-colors border-b border-gray-50 last:border-0 flex items-center justify-between"
                                          >
                                            <span>
                                              <span className="text-sm text-gray-900">{tpl.templateName}</span>
                                              <span className="text-xs text-gray-400 ml-2">({tpl.parameterCount}p)</span>
                                            </span>
                                            <span className="flex items-center gap-1.5">
                                              <span className="text-[10px] text-gray-400">
                                                {selectedNumbers.filter((id) => tpl.availableOn.includes(id)).length}/{selectedNumbers.length} numbers
                                              </span>
                                              {tpl.category && (() => {
                                                const optAvailable = selectedNumbers.filter((id) => tpl.availableOn.includes(id));
                                                const optMarketing = optAvailable.filter((id) => tpl.categoryPerNumber?.[id] === "MARKETING");
                                                const optMixed = optMarketing.length > 0 && optMarketing.length < optAvailable.length;
                                                return (
                                                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${optMixed ? "bg-amber-100 text-amber-700" : tpl.category === "MARKETING" ? "bg-orange-100 text-orange-700" : "bg-green-100 text-green-700"}`}>
                                                    {optMixed ? "MIXED" : tpl.category === "MARKETING" ? "MKT" : "UTL"}
                                                  </span>
                                                );
                                              })()}
                                            </span>
                                          </button>
                                        ))}
                                      {templates.filter((t) => t.templateName.includes(tplSearch.toLowerCase())).length === 0 && (
                                        <p className="px-3 py-3 text-xs text-gray-400 text-center">No templates found</p>
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* Availability badge — tells the team up front which numbers still need this template approved */}
                                {rk.templateName && (
                                  <div className={`text-xs px-3 py-2 rounded-lg border ${availableCount === selectedNumbers.length ? "bg-green-50 border-green-200 text-green-700" : availableCount === 0 ? "bg-red-50 border-red-200 text-red-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>
                                    {availableCount === selectedNumbers.length
                                      ? `✓ Approved on all ${selectedNumbers.length} sending numbers`
                                      : `Approved on ${availableCount}/${selectedNumbers.length} numbers — missing on ${missingNumbers.slice(0, 6).map(getNumberLabel).join(", ")}${missingNumbers.length > 6 ? ` and ${missingNumbers.length - 6} more` : ""}. Use "Copy to others" on the Templates page to fill the gap.`}
                                  </div>
                                )}

                                {/* Category breakdown — only shown when it actually differs per number, since
                                    MARKETING messages have stricter sending windows/opt-out rules than UTILITY. */}
                                {rk.templateName && categoryMixed && (
                                  <div className="text-xs px-3 py-2 rounded-lg border bg-orange-50 border-orange-200 text-orange-700">
                                    MARKETING on {marketingNumbers.length}/{availableCount} approved numbers: {marketingNumbers.slice(0, 6).map(getNumberLabel).join(", ")}{marketingNumbers.length > 6 ? ` and ${marketingNumbers.length - 6} more` : ""}. The rest are UTILITY.
                                  </div>
                                )}

                                {/* Header structure breakdown -- shown only when it differs per
                                    number. On 2026-09-17 this mismatch cost the 7 PM Power BI batch
                                    its entire "20 mins to go" send: the config had an image, every
                                    number was marked as taking it, and the 13 whose copy has no
                                    header slot had every message rejected by Meta. */}
                                {rk.templateName && headerMixed && (
                                  <div className="text-xs px-3 py-2 rounded-lg border bg-amber-50 border-amber-200 text-amber-700">
                                    Image header on only {imageHeaderNumbers.length}/{availableCount} approved numbers:{" "}
                                    {imageHeaderNumbers.slice(0, 6).map(getNumberLabel).join(", ")}
                                    {imageHeaderNumbers.length > 6 ? ` and ${imageHeaderNumbers.length - 6} more` : ""}. The
                                    other {availableCount - imageHeaderNumbers.length} send text-only -- they get no image
                                    even if you set one here. Re-approve the template with the same structure everywhere
                                    to fix that.
                                  </div>
                                )}

                                {/* Image Header picker -- driven by hasImageHeaderPerNumber, not by
                                    whichever number's copy happened to define selTpl.components. */}
                                {rk.templateName && imageHeaderNumbers.length > 0 && (
                                  <div>
                                    <p className="text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">
                                      Header Image
                                      {needsImage && <span className="text-red-600 normal-case"> required, none set</span>}
                                    </p>
                                    <div className={needsImage ? "ring-2 ring-red-200 rounded-lg" : ""}>
                                      <ImagePicker
                                        value={rk.headerImageUrl || ""}
                                        onChange={(url) => updateRunKey(runKey, "headerImageUrl", url)}
                                      />
                                    </div>
                                    {needsImage && (
                                      <p className="text-[11px] text-red-600 mt-1">
                                        This template has an image header on {imageHeaderNumbers.length} number
                                        {imageHeaderNumbers.length === 1 ? "" : "s"}. Without an image those sends fail.
                                      </p>
                                    )}
                                  </div>
                                )}

                                {/* Template body preview with sample data */}
                                {rk.templateName && (() => {
                                  const bodyText = selTpl?.components?.find((c) => (c.type as string).toUpperCase() === "BODY")?.text;
                                  if (!bodyText) return null;
                                  const previewText = bodyText.replace(/\{\{(\d+)\}\}/g, (_, num) => {
                                    const idx = parseInt(num) - 1;
                                    const paramKey = (rk.bodyParams || [])[idx];
                                    if (!paramKey) return `[param ${num}]`;
                                    return getParamSampleValue(paramKey);
                                  });
                                  return (
                                    <div className="p-3 bg-gradient-to-r from-slate-50 to-gray-50 rounded-lg text-xs text-gray-600 whitespace-pre-wrap border border-gray-100 leading-relaxed">
                                      {previewText}
                                    </div>
                                  );
                                })()}

                                {/* Params */}
                                <div>
                                  <p className="text-[10px] font-medium text-gray-500 mb-1.5 uppercase tracking-wide">Parameters</p>
                                  <div className="flex flex-wrap gap-1.5 items-center">
                                    {(rk.bodyParams || []).map((param, idx) => {
                                      const paramSearchKey = `param_${runKey}_${idx}`;
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
                                                  const p = [...(rk.bodyParams || [])]; p[idx] = "";
                                                  updateRunKey(runKey, "bodyParams", p);
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
                                              const p = [...(rk.bodyParams || [])]; p.splice(idx, 1);
                                              updateRunKey(runKey, "bodyParams", p);
                                            }} className="text-red-300 hover:text-red-500 pr-2"><Trash2 className="w-3 h-3" /></button>
                                          </div>
                                          {paramOpen && !param && (
                                            <div className="absolute z-50 w-44 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-40 overflow-y-auto">
                                              {allParams.filter((p) => p.toLowerCase().includes(paramSearch.toLowerCase())).map((p) => (
                                                <button
                                                  key={p}
                                                  onMouseDown={(e) => {
                                                    e.preventDefault();
                                                    const params = [...(rk.bodyParams || [])]; params[idx] = p;
                                                    updateRunKey(runKey, "bodyParams", params);
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
                                    <button onClick={() => updateRunKey(runKey, "bodyParams", [...(rk.bodyParams || []), ""])} className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-0.5 px-2 py-1.5 rounded-lg hover:bg-primary-50 border border-dashed border-primary-200">
                                      <Plus className="w-3 h-3" /> param
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {toast && <div className="fixed bottom-6 right-6 px-5 py-3 rounded-xl shadow-lg text-sm font-medium bg-gray-900 text-white z-50">{toast}</div>}
          </div>
      </AppShell>
    </AuthGuard>
  );
}
