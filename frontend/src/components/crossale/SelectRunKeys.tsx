"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import { WorkshopEntry } from "@/app/crossale/page";
import { inferRunKeyOffset, toSignedMinutes, OffsetDirection } from "@/lib/runKeyOffset";
import { TemplateComponent, Business } from "@/types";
import ImagePicker from "@/components/campaign/ImagePicker";
import TemplatePreview from "@/components/campaign/TemplatePreview";
import TimePicker12h from "@/components/campaign/TimePicker12h";
import { RefreshCw, ChevronDown } from "lucide-react";

// Same picker convention Workshop Config's own run-key editor uses
// (frontend/src/app/workshops/config/page.tsx) — kept in sync manually
// since these describe the same CSV columns crossale/create.ts's
// CSV_COLUMNS produces on the backend.
const DB_PARAMS = ["name", "zoom_link", "whatsapp_group", "workshop_name", "workshop_date", "workshop_time"];
const COMPUTED_PARAMS = ["full_workshop_name", "workshop_name_w", "workshop_date_time", "workshop_time_short", "mentor_name", "w_type", "w_name", "w_date", "three_hours_text", "duration"];
const STATIC_SENTINEL = "__STATIC__";

interface ManualTemplate {
  templateName: string;
  category: string;
  parameterCount: number;
  components: TemplateComponent[];
  // Per-number approval data — same shape SelectTemplate.tsx/SelectAdditionalNumbers.tsx
  // already rely on, needed here to check a template against one specific
  // main number and to gate which additional numbers are eligible.
  availableOn: string[];
  categoryPerNumber?: Record<string, string>;
  paramCountPerNumber?: Record<string, number>;
}

export interface RunKeySelection {
  runKey: string;
  templateName: string;
  bodyParams: string[];
  headerImageUrl?: string;
  offsetMinutes: number; // signed: positive = before workshop start, negative = after
  selected: boolean;
  // Manual mode only — the number the template gets checked against first,
  // plus the full sending pool for this message (main + any eligible
  // additional numbers picked). Auto mode ignores both.
  mainNumberId?: string;
  numberIds?: string[];
}

interface Props {
  entry: WorkshopEntry;
  onUpdate: (updates: Partial<WorkshopEntry>) => void;
  onNext: () => void;
  onBack: () => void;
}

interface ConfigRunKey {
  templateName: string;
  bodyParams: string[];
  headerImageUrl?: string;
  offsetMinutes?: number;
}
interface WorkshopConfigResponse {
  businessId?: string;
  numbers: Record<string, unknown>;
  runKeys: Record<string, ConfigRunKey>;
  activeRunKeys?: string[];
}

// Decomposes a signed offsetMinutes (positive = before promoted start,
// negative = after — the only thing actually stored) into what a human
// thinks in: "N days before/after, at HH:MM" instead of a raw duration that
// needs mental math to see what clock time it lands on. Same model as
// Workshop Config's run-key editor — daysOffset is 0 for same-day run keys
// (its_7_10_pm, we_are_live, ...), where the exact time alone already
// captures before/after, so the direction dropdown only matters once
// daysOffset > 0. Pure minute arithmetic relative to promotedTime's own
// minutes-since-midnight — safe from timezone/DST edge cases since India
// has no DST and this never touches the calendar date directly.
interface DecomposedOffset {
  daysOffset: number;
  direction: OffsetDirection;
  timeOfDayHHMM: string;
}
function decomposeOffset(signedOffsetMinutes: number, promotedTimeHHMM: string): DecomposedOffset {
  const [ph, pm] = promotedTimeHHMM.split(":").map(Number);
  const promotedMinutes = ph * 60 + pm;
  const sendMinutesFromPromotedMidnight = promotedMinutes - signedOffsetMinutes;
  const dayIndex = Math.floor(sendMinutesFromPromotedMidnight / 1440);
  const timeOfDayMinutes = ((sendMinutesFromPromotedMidnight % 1440) + 1440) % 1440;
  const hh = Math.floor(timeOfDayMinutes / 60);
  const mm = timeOfDayMinutes % 60;
  return {
    daysOffset: Math.abs(dayIndex),
    direction: dayIndex <= 0 ? "before" : "after",
    timeOfDayHHMM: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
  };
}
function composeOffset(daysOffset: number, direction: OffsetDirection, timeOfDayHHMM: string, promotedTimeHHMM: string): number {
  const [ph, pm] = promotedTimeHHMM.split(":").map(Number);
  const [th, tm] = timeOfDayHHMM.split(":").map(Number);
  const clockDiff = (ph * 60 + pm) - (th * 60 + tm);
  const daysComponent = direction === "before" ? daysOffset * 1440 : -daysOffset * 1440;
  return daysComponent + clockDiff;
}

function computeSendMoment(entry: WorkshopEntry, signedOffsetMinutes: number): Date | null {
  if (!entry.promotedDate) return null;
  const promoted = new Date(`${entry.promotedDate}T${entry.promotedTime}:00+05:30`);
  return new Date(promoted.getTime() - signedOffsetMinutes * 60000);
}

function formatClockTime(entry: WorkshopEntry, signedOffsetMinutes: number): string {
  const sendMoment = computeSendMoment(entry, signedOffsetMinutes);
  if (!sendMoment) return "";
  return sendMoment.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

function isPast(entry: WorkshopEntry, signedOffsetMinutes: number): boolean {
  const sendMoment = computeSendMoment(entry, signedOffsetMinutes);
  return sendMoment ? sendMoment.getTime() <= Date.now() : false;
}

function OffsetEditor({ signedMinutes, promotedTimeHHMM, onChange }: { signedMinutes: number; promotedTimeHHMM: string; onChange: (signed: number) => void }) {
  const { daysOffset, direction, timeOfDayHHMM } = decomposeOffset(signedMinutes, promotedTimeHHMM);

  return (
    <>
      <input
        type="number"
        min={0}
        value={daysOffset}
        onChange={(e) => onChange(composeOffset(Math.max(0, Number(e.target.value) || 0), direction, timeOfDayHHMM, promotedTimeHHMM))}
        className="w-14 border border-gray-200 rounded-lg px-2 py-1 text-xs"
      />
      <span className="text-xs text-gray-500">day{daysOffset === 1 ? "" : "s"}</span>
      <select
        value={direction}
        onChange={(e) => onChange(composeOffset(daysOffset, e.target.value as OffsetDirection, timeOfDayHHMM, promotedTimeHHMM))}
        disabled={daysOffset === 0}
        className="border border-gray-200 rounded-lg px-2 py-1 text-xs disabled:opacity-40"
      >
        <option value="before">before start</option>
        <option value="after">after start</option>
      </select>
      <span className="text-xs text-gray-500">at</span>
      <TimePicker12h
        value={timeOfDayHHMM}
        onChange={(v) => onChange(composeOffset(daysOffset, direction, v, promotedTimeHHMM))}
        className="text-xs"
      />
    </>
  );
}

// A number's template catalog here can run into the hundreds (real accounts
// have accumulated a template per workshop-run-key-variant over time), and
// their names are often cryptic short codes (e.g. "1day_to_go_cs_6pm_backup")
// — a plain <select> forces scrolling through the whole list with no way to
// jump to what you're looking for. Own component (not inline state in
// renderManualRunKey) because that function runs inside a .map() over a
// variable-length array — hooks called there would violate the rules of
// hooks the moment a row is added or removed.
function TemplateSearchSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (templateName: string) => void;
  options: { templateName: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
  const selected = options.find((o) => o.templateName === value);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        className="w-full flex items-center justify-between gap-2 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-left bg-white"
      >
        <span className={`truncate ${selected ? "text-gray-900" : "text-gray-400"}`}>
          {selected ? selected.label : "Select template..."}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg flex flex-col">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates..."
            className="w-full border-b border-gray-100 px-3 py-1.5 text-xs outline-none rounded-t-lg"
          />
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-3">No templates match &quot;{query}&quot;</p>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.templateName}
                  type="button"
                  onClick={() => {
                    onChange(o.templateName);
                    setOpen(false);
                  }}
                  className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 ${
                    o.templateName === value ? "bg-primary-50 text-primary-700 font-medium" : "text-gray-700"
                  }`}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SelectRunKeys({ entry, onUpdate, onNext, onBack }: Props) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [configLoading, setConfigLoading] = useState(true);
  const [noNumbers, setNoNumbers] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [manualTemplates, setManualTemplates] = useState<ManualTemplate[]>([]);
  const [manualTemplatesLoading, setManualTemplatesLoading] = useState(false);
  const [syncingTemplates, setSyncingTemplates] = useState(false);
  // Defaults to "healthy" (not "all") — RED numbers have historically made up
  // the majority of a business's pool (e.g. 37 of 54 on Skill Nation), so
  // showing everything by default let "Select all eligible" mass-select a
  // pile of bad numbers with one click.
  const [qualityFilter, setQualityFilter] = useState<"all" | "healthy" | "green">("healthy");

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses")
      .then((d) => setBusinesses(d.businesses))
      .catch(() => {});
  }, []);

  // Shared Workshop Config fetch — prefills entry.businessId (once, if
  // still unset) for either mode the same way WorkshopBatchDetails.tsx
  // used to, and in Auto mode also derives run keys/templates/numbers from
  // it, same logic as before, just triggered from this step now.
  useEffect(() => {
    apiRequest<{ config: WorkshopConfigResponse | null }>(`/workshops/config?wsCode=${entry.targetWsCode}&cycle=0`)
      .then((d) => {
        const cfg = d.config;
        if (cfg?.businessId && !entry.businessId) onUpdate({ businessId: cfg.businessId });
        if (entry.mode !== "auto" || entry.runKeys.length > 0 || !cfg) return;
        setNoNumbers(Object.keys(cfg.numbers || {}).length === 0);
        const keys = cfg.activeRunKeys || Object.keys(cfg.runKeys || {});
        const selections: RunKeySelection[] = keys
          .filter((rk) => cfg.runKeys?.[rk]?.templateName)
          .map((rk) => {
            const saved = cfg.runKeys[rk].offsetMinutes;
            // Nobody has manually set offsetMinutes yet on most run keys —
            // infer a sensible default from the name (e.g. its_7_10_pm = 10
            // min after a 7pm start) rather than showing everything as
            // "0 days before". A saved value always wins once it exists.
            const inferred = saved === undefined || saved === null ? inferRunKeyOffset(rk, entry.promotedTime) : null;
            const offsetMinutes = saved ?? (inferred ? toSignedMinutes(inferred.minutes, inferred.direction) : 0);
            return {
              runKey: rk,
              templateName: cfg.runKeys[rk].templateName,
              bodyParams: cfg.runKeys[rk].bodyParams || [],
              headerImageUrl: cfg.runKeys[rk].headerImageUrl || "",
              offsetMinutes,
              // A run key whose computed time already passed shouldn't be
              // selected by default — sending "2 days to go" after that
              // point has already passed makes no sense.
              selected: !isPast(entry, offsetMinutes),
            };
          });
        onUpdate({ runKeys: selections });
      })
      .finally(() => setConfigLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.targetWsCode]);

  // Manual mode's template list depends on which business got picked in
  // this same step (business selection moved here from the previous step).
  // Fetched once per business against ALL of its numbers — one call gives
  // both the per-row template list (filtered to whatever main number that
  // row picks) and the per-number availability data every row's
  // additional-numbers stage needs, so every row shares this same dataset
  // instead of each doing its own fetch.
  const loadManualTemplates = () => {
    if (entry.mode !== "manual" || !entry.businessId) return;
    const biz = businesses.find((b) => b.businessId === entry.businessId);
    if (!biz) return;
    setManualTemplatesLoading(true);
    apiRequest<{ templates: ManualTemplate[] }>(
      `/templates?businessId=${entry.businessId}&phoneNumberIds=${biz.phoneNumbers.map((n) => n.phoneNumberId).join(",")}`
    )
      .then((d) => setManualTemplates(d.templates || []))
      .catch(() => setManualTemplates([]))
      .finally(() => setManualTemplatesLoading(false));
  };

  useEffect(() => {
    loadManualTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.mode, entry.businessId, businesses]);

  // Re-pulls this business's templates fresh from Meta before re-loading our
  // DB copy — covers the case where a template was approved on Meta's side
  // after the last sync, so it's showing here as "no templates approved"
  // even though it's really just stale local data.
  const syncTemplates = async () => {
    if (!entry.businessId) return;
    setSyncingTemplates(true);
    try {
      await apiRequest("/templates/fetch", { method: "POST", body: JSON.stringify({ businessId: entry.businessId }) });
      loadManualTemplates();
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncingTemplates(false);
    }
  };

  const selectedBusiness = businesses.find((b) => b.businessId === entry.businessId);
  // Stricter than round-robin.ts's send-time "healthy" (which only excludes
  // RED) — this is a human picking numbers up front, not a live fallback, so
  // UNKNOWN (never quality-checked) doesn't get the benefit of the doubt here.
  const passesQualityFilter = (n: { qualityRating?: string }) => {
    if (qualityFilter === "all") return true;
    if (qualityFilter === "green") return n.qualityRating === "GREEN";
    return n.qualityRating === "GREEN" || n.qualityRating === "YELLOW";
  };
  const manualNumberPool = (selectedBusiness?.phoneNumbers || []).filter(passesQualityFilter);

  const toggle = (runKey: string) => {
    onUpdate({ runKeys: entry.runKeys.map((r) => (r.runKey === runKey ? { ...r, selected: !r.selected } : r)) });
  };

  const updateOffset = (runKey: string, offsetMinutes: number) => {
    onUpdate({ runKeys: entry.runKeys.map((r) => (r.runKey === runKey ? { ...r, offsetMinutes } : r)) });
  };

  // Manual mode's run keys are free-text labels the user can rename, so
  // (unlike Auto mode's stable config-derived keys) they're addressed by
  // array index rather than by the runKey string itself.
  const addManualRunKey = () => {
    onUpdate({
      runKeys: [
        ...entry.runKeys,
        { runKey: "", templateName: "", bodyParams: [], headerImageUrl: "", offsetMinutes: 0, selected: true, mainNumberId: undefined, numberIds: [] },
      ],
    });
  };
  const updateManualRunKey = (index: number, updates: Partial<RunKeySelection>) => {
    onUpdate({ runKeys: entry.runKeys.map((r, i) => (i === index ? { ...r, ...updates } : r)) });
  };
  const removeManualRunKey = (index: number) => {
    onUpdate({ runKeys: entry.runKeys.filter((_, i) => i !== index) });
  };

  const selectedCount = entry.runKeys.filter((r) => r.selected).length;
  const upcoming = entry.runKeys.filter((rk) => !isPast(entry, rk.offsetMinutes));
  const past = entry.runKeys.filter((rk) => isPast(entry, rk.offsetMinutes));

  const renderRunKey = (rk: RunKeySelection) => (
    <div key={rk.runKey} className={`border rounded-xl p-3 ${rk.selected ? "border-primary-300 bg-primary-50/40" : "border-gray-100"}`}>
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={rk.selected}
          onChange={() => toggle(rk.runKey)}
          className="w-4 h-4 text-primary-600 rounded"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900">{rk.runKey}</p>
          <p className="text-xs text-gray-500 font-mono truncate">{rk.templateName}</p>
        </div>
      </label>
      {rk.selected && (
        <div className="mt-2 ml-7 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">Send</span>
          <OffsetEditor signedMinutes={rk.offsetMinutes} promotedTimeHHMM={entry.promotedTime} onChange={(m) => updateOffset(rk.runKey, m)} />
          <span className="text-xs text-gray-400">→ {formatClockTime(entry, rk.offsetMinutes)}</span>
        </div>
      )}
    </div>
  );

  // Mirrors the real Campaign wizard's sequence per message — SelectMainNumber
  // → SelectTemplate → SelectAdditionalNumbers → MapParameters — just inline
  // within one row instead of separate wizard steps, since a message here is
  // the equivalent of one simple campaign.
  const renderManualRunKey = (rk: RunKeySelection, index: number) => {
    const mainNumber = selectedBusiness?.phoneNumbers.find((n) => n.phoneNumberId === rk.mainNumberId);
    const tpl = manualTemplates.find((t) => t.templateName === rk.templateName);
    const availableTemplates = rk.mainNumberId
      ? manualTemplates.filter((t) => t.availableOn.includes(rk.mainNumberId!))
      : [];
    // A number whose own synced copy of this template has a DIFFERENT param
    // count than the main number's isn't just "ineligible" (a state the team
    // can see and understand, like MARKETING-only) — sending it would map
    // the wrong values into the wrong {{n}} placeholders, so it's dropped
    // from the list entirely rather than shown disabled with a reason.
    const otherNumbers = manualNumberPool
      .filter((n) => n.phoneNumberId !== rk.mainNumberId)
      .filter((n) => {
        const count = tpl?.paramCountPerNumber?.[n.phoneNumberId];
        return count === undefined || count === tpl?.parameterCount;
      });
    const isEligible = (numberId: string) =>
      !!tpl?.availableOn.includes(numberId) && tpl?.categoryPerNumber?.[numberId] !== "MARKETING";
    const ineligibleReason = (numberId: string) => {
      if (!tpl?.availableOn.includes(numberId)) return "Doesn't have this template";
      if (tpl?.categoryPerNumber?.[numberId] === "MARKETING") return "MARKETING only";
      return "";
    };
    const selectAllEligibleAdditional = () => {
      const eligibleIds = otherNumbers.filter((n) => isEligible(n.phoneNumberId)).map((n) => n.phoneNumberId);
      const merged = Array.from(new Set([...(rk.numberIds || []), ...eligibleIds]));
      updateManualRunKey(index, { numberIds: merged });
    };
    const hasImageHeader = tpl?.components?.some(
      (c) => (c.type as string).toUpperCase() === "HEADER" && (c.format || "").toUpperCase() === "IMAGE"
    );

    // Changing the main number invalidates whatever template was already
    // chosen against the old one — same rule SelectMainNumber.tsx uses.
    const setMainNumber = (numberId: string) => {
      if (rk.mainNumberId === numberId) return;
      updateManualRunKey(index, { mainNumberId: numberId, templateName: "", bodyParams: [], numberIds: [numberId] });
    };

    const setTemplate = (templateName: string) => {
      const chosen = manualTemplates.find((t) => t.templateName === templateName);
      updateManualRunKey(index, {
        templateName,
        bodyParams: chosen ? Array(chosen.parameterCount).fill("") : [],
        numberIds: rk.mainNumberId ? [rk.mainNumberId] : [],
      });
    };

    const toggleAdditionalNumber = (numberId: string) => {
      if (!isEligible(numberId)) return;
      const has = (rk.numberIds || []).includes(numberId);
      updateManualRunKey(index, {
        numberIds: has ? (rk.numberIds || []).filter((id) => id !== numberId) : [...(rk.numberIds || []), numberId],
      });
    };

    const updateParam = (pi: number, value: string) => {
      const p = [...rk.bodyParams];
      p[pi] = value;
      updateManualRunKey(index, { bodyParams: p });
    };

    const previewValues: Record<string, string> = {};
    rk.bodyParams.forEach((p, i) => {
      previewValues[String(i + 1)] = p.startsWith(STATIC_SENTINEL) ? p.slice(STATIC_SENTINEL.length) || "___" : p ? `[${p}]` : "___";
    });

    return (
      <div key={index} className={`border rounded-xl p-3 ${rk.selected ? "border-primary-300 bg-primary-50/40" : "border-gray-100"}`}>
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={rk.selected}
            onChange={() => updateManualRunKey(index, { selected: !rk.selected })}
            className="w-4 h-4 mt-2.5 text-primary-600 rounded shrink-0"
          />
          <div className="flex-1 min-w-0 space-y-3">
            <input
              type="text"
              value={rk.runKey}
              onChange={(e) => updateManualRunKey(index, { runKey: e.target.value })}
              placeholder="Message label (e.g. reminder_1)"
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium"
            />

            {/* Stage 1: main number */}
            <div>
              <p className="text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">Main number</p>
              {!selectedBusiness ? (
                <p className="text-xs text-gray-400">Pick a business above first.</p>
              ) : manualNumberPool.length === 0 ? (
                <p className="text-xs text-red-500">No numbers match this quality filter — loosen the &quot;Quality&quot; dropdown above to see more.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto">
                  {manualNumberPool.map((n) => (
                    <label
                      key={n.phoneNumberId}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border cursor-pointer text-xs ${
                        rk.mainNumberId === n.phoneNumberId ? "border-primary-500 bg-primary-50" : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`main-${index}`}
                        checked={rk.mainNumberId === n.phoneNumberId}
                        onChange={() => setMainNumber(n.phoneNumberId)}
                        className="w-3.5 h-3.5 text-primary-600 shrink-0"
                      />
                      <span className="truncate">
                        {n.displayName} <span className="text-gray-400">{n.displayNumber}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Stage 2: template — checked against the main number */}
            {rk.mainNumberId && (
              <div>
                <p className="text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">
                  Template — checked against {mainNumber?.displayName}
                </p>
                {manualTemplatesLoading ? (
                  <p className="text-xs text-gray-400">Loading templates...</p>
                ) : availableTemplates.length === 0 ? (
                  <p className="text-xs text-red-500">No templates approved on this number.</p>
                ) : (
                  <TemplateSearchSelect
                    value={rk.templateName}
                    onChange={setTemplate}
                    options={availableTemplates.map((t) => ({
                      templateName: t.templateName,
                      label: `${t.templateName} (${t.parameterCount}p, ${t.categoryPerNumber?.[rk.mainNumberId!] || t.category})`,
                    }))}
                  />
                )}
              </div>
            )}

            {/* Stage 3: additional numbers — optional, once a template is confirmed */}
            {rk.templateName && otherNumbers.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                    Additional numbers (optional)
                    <span className="normal-case text-gray-400 font-normal ml-1">
                      ({(rk.numberIds || []).filter((id) => id !== rk.mainNumberId).length} of {otherNumbers.filter((n) => isEligible(n.phoneNumberId)).length} selected)
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={selectAllEligibleAdditional}
                    className="text-[10px] text-primary-600 hover:text-primary-700 font-medium"
                  >
                    Select all eligible
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto">
                  {otherNumbers.map((n) => {
                    const eligible = isEligible(n.phoneNumberId);
                    const isSelected = (rk.numberIds || []).includes(n.phoneNumberId);
                    return (
                      <label
                        key={n.phoneNumberId}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border text-xs ${
                          !eligible
                            ? "border-gray-100 bg-gray-50 cursor-not-allowed opacity-60"
                            : isSelected
                            ? "border-primary-500 bg-primary-50 cursor-pointer"
                            : "border-gray-200 hover:border-gray-300 cursor-pointer"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!eligible}
                          onChange={() => toggleAdditionalNumber(n.phoneNumberId)}
                          className="w-3.5 h-3.5 text-primary-600 rounded shrink-0 disabled:opacity-50"
                        />
                        <span className="truncate">
                          {n.displayName} <span className="text-gray-400">{n.displayNumber}</span>
                          {!eligible && <span className="block text-[10px] text-gray-400">{ineligibleReason(n.phoneNumberId)}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Stage 4: parameters, with a live preview */}
            {rk.templateName && rk.bodyParams.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-3">
                <div className="space-y-2">
                  {rk.bodyParams.map((param, pi) => {
                    const isStatic = param.startsWith(STATIC_SENTINEL);
                    return (
                      <div key={pi} className="border border-gray-100 rounded-lg p-2">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs font-medium text-gray-600 w-10">{`{{${pi + 1}}}`}</span>
                          <div className="flex bg-gray-100 rounded-md p-0.5">
                            <button
                              onClick={() => updateParam(pi, "")}
                              className={`px-2 py-0.5 text-[11px] rounded ${!isStatic ? "bg-white text-gray-900 shadow-sm font-medium" : "text-gray-500"}`}
                            >
                              From data
                            </button>
                            <button
                              onClick={() => updateParam(pi, STATIC_SENTINEL)}
                              className={`px-2 py-0.5 text-[11px] rounded ${isStatic ? "bg-white text-gray-900 shadow-sm font-medium" : "text-gray-500"}`}
                            >
                              Static value
                            </button>
                          </div>
                        </div>
                        {isStatic ? (
                          <input
                            type="text"
                            value={param.replace(STATIC_SENTINEL, "")}
                            onChange={(e) => updateParam(pi, `${STATIC_SENTINEL}${e.target.value}`)}
                            placeholder="Static value (same for everyone)"
                            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5"
                          />
                        ) : (
                          <select
                            value={param}
                            onChange={(e) => updateParam(pi, e.target.value)}
                            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5"
                          >
                            <option value="">Select column...</option>
                            {DB_PARAMS.map((p) => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                            {COMPUTED_PARAMS.map((p) => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}

                  {hasImageHeader && (
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">Header Image</p>
                      <ImagePicker value={rk.headerImageUrl || ""} onChange={(url) => updateManualRunKey(index, { headerImageUrl: url })} />
                    </div>
                  )}
                </div>
                <div className="lg:sticky lg:top-4 self-start">
                  <TemplatePreview
                    template={tpl ? { components: tpl.components } : null}
                    resolvedValues={previewValues}
                    headerImageUrl={rk.headerImageUrl}
                  />
                </div>
              </div>
            )}

            {rk.selected && rk.templateName && (
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <span className="text-xs text-gray-500">Send</span>
                <OffsetEditor signedMinutes={rk.offsetMinutes} promotedTimeHHMM={entry.promotedTime} onChange={(m) => updateManualRunKey(index, { offsetMinutes: m })} />
                <span className="text-xs text-gray-400">→ {formatClockTime(entry, rk.offsetMinutes)}</span>
              </div>
            )}
          </div>
          <button onClick={() => removeManualRunKey(index)} className="text-xs text-red-400 hover:text-red-600 shrink-0">
            Remove
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">Select Run Keys</h3>
      <p className="text-sm text-gray-500 mb-4">
        {entry.mode === "auto" ? (
          <>
            One campaign gets created per selected run key, using {entry.targetWsCode}&apos;s Workshop Config templates and sending numbers.
            Timing below is inferred from each run key&apos;s name against your promoted date/time — check it before creating.
          </>
        ) : (
          "One campaign gets created per message you add below, using the business and numbers picked here."
        )}
      </p>

      <div className="mb-5">
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs font-medium text-gray-600">Business</label>
          {entry.mode === "manual" && entry.businessId && (
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                Quality
                <select
                  value={qualityFilter}
                  onChange={(e) => setQualityFilter(e.target.value as "all" | "healthy" | "green")}
                  className="border border-gray-200 rounded-lg px-2 py-1 text-xs"
                >
                  <option value="healthy">Green + Yellow</option>
                  <option value="green">Green only</option>
                  <option value="all">All (incl. Red)</option>
                </select>
              </label>
              <button
                type="button"
                onClick={syncTemplates}
                disabled={syncingTemplates}
                className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${syncingTemplates ? "animate-spin" : ""}`} /> {syncingTemplates ? "Syncing..." : "Sync Templates"}
              </button>
            </div>
          )}
        </div>
        <p className="text-xs text-amber-600 mb-2">Confirm this is correct — Workshop Config&apos;s saved business can be stale.</p>
        <div className="flex flex-wrap gap-2">
          {businesses.map((b) => (
            <button
              key={b.businessId}
              onClick={() => onUpdate({ businessId: b.businessId })}
              className={`px-4 py-2 rounded-lg text-sm font-medium border ${
                entry.businessId === b.businessId
                  ? "border-primary-500 bg-primary-50 text-primary-700"
                  : "border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              {b.businessName}
            </button>
          ))}
        </div>
      </div>

      {entry.mode === "manual" ? (
        <>
          <div className="space-y-2">
            {entry.runKeys.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">No messages added yet.</p>
            ) : (
              entry.runKeys.map((rk, i) => renderManualRunKey(rk, i))
            )}
          </div>
          <button
            onClick={addManualRunKey}
            className="mt-3 text-sm text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1"
          >
            + Add message
          </button>
        </>
      ) : configLoading ? (
        <p className="text-sm text-gray-400 py-6 text-center">Loading run keys...</p>
      ) : noNumbers ? (
        <p className="text-sm text-red-500 py-6 text-center">
          No sending numbers configured for this workshop in Workshop Config.
        </p>
      ) : entry.runKeys.length === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center">No run keys with a template configured for this workshop yet.</p>
      ) : (
        <>
          <div className="space-y-2">
            {upcoming.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">
                Every run key&apos;s computed time is already past for this promoted date — adjust the date or offsets below.
              </p>
            ) : (
              upcoming.map(renderRunKey)
            )}
          </div>

          {past.length > 0 && (
            <div className="mt-3">
              <button onClick={() => setShowPast((v) => !v)} className="text-xs text-gray-400 hover:text-gray-600">
                {showPast ? "Hide" : "Show"} {past.length} run key{past.length !== 1 ? "s" : ""} already past for this date
              </button>
              {showPast && <div className="space-y-2 mt-2 opacity-60">{past.map(renderRunKey)}</div>}
            </div>
          )}
        </>
      )}

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={onNext}
          disabled={
            !entry.businessId ||
            selectedCount === 0 ||
            (entry.mode === "manual" &&
              entry.runKeys.some(
                (r) => r.selected && (!r.runKey.trim() || !r.templateName || !r.numberIds?.length)
              ))
          }
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next ({selectedCount} run key{selectedCount !== 1 ? "s" : ""})
        </button>
      </div>
    </div>
  );
}
