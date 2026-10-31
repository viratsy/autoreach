"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { WorkshopEntry } from "@/app/crossale/page";
import TestNumbersPanel from "@/components/shared/TestNumbersPanel";

interface RegistryWorkshop {
  code: string;
  displayName: string;
}

interface Props {
  entry: WorkshopEntry;
  onUpdate: (updates: Partial<WorkshopEntry>) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function WorkshopBatchDetails({ entry, onUpdate, onNext, onBack }: Props) {
  const [registryWorkshops, setRegistryWorkshops] = useState<RegistryWorkshop[]>([]);

  useEffect(() => {
    apiRequest<{ workshops: RegistryWorkshop[] }>("/workshops/registry")
      .then((d) => setRegistryWorkshops(d.workshops))
      .catch(() => {});
  }, []);

  // Drops one batch from one source, and the source itself once its last
  // batch goes, so the pooled audience count stays honest.
  const removeBatch = (wsCode: string, date: string) => {
    const sources = entry.sources
      .map((src) =>
        src.wsCode === wsCode
          ? { ...src, batchDates: src.batchDates.filter((d) => d !== date) }
          : src
      )
      .filter((src) => src.batchDates.length > 0);
    onUpdate({ sources });
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">
        {entry.sources.map((src) => src.workshopName).join(" + ")}
      </h3>
      <p className="text-sm text-gray-500 mb-5">Confirm the batch(es) and the new date being promoted. Business, numbers, and templates get picked in the next step.</p>

      <div className="space-y-5">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">Which workshop is this for?</label>
          <p className="text-xs text-gray-500 mb-2">
            Pick the workshop being promoted. It's independent of where the audience came
            from, so attendees of {entry.sources.map((src) => src.workshopName).join(" and ")} can all be
            invited to something else.
          </p>
          <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
            {registryWorkshops.map((w) => (
              <button
                key={w.code}
                onClick={() => onUpdate({ targetWsCode: w.code, targetWorkshopName: w.displayName })}
                className={`px-4 py-2 rounded-lg text-sm font-medium border ${
                  entry.targetWsCode === w.code
                    ? "border-primary-500 bg-primary-50 text-primary-700"
                    : "border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                {w.displayName}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">Template & numbers</label>
          <div className="flex gap-2">
            <button
              onClick={() => entry.mode !== "auto" && onUpdate({ mode: "auto", runKeys: [] })}
              className={`px-4 py-2 rounded-lg text-sm font-medium border ${
                entry.mode === "auto"
                  ? "border-primary-500 bg-primary-50 text-primary-700"
                  : "border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              {/* Reads as "use 's Workshop Config" before a target is picked —
                  which is the default state now that a pooled audience has no
                  single source to default the target from. */}
              Auto (use {entry.targetWsCode ? `${entry.targetWsCode}'s` : "the target workshop's"} Workshop
              Config)
            </button>
            <button
              onClick={() => entry.mode !== "manual" && onUpdate({ mode: "manual", runKeys: [] })}
              className={`px-4 py-2 rounded-lg text-sm font-medium border ${
                entry.mode === "manual"
                  ? "border-primary-500 bg-primary-50 text-primary-700"
                  : "border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              Manual (pick numbers & templates myself)
            </button>
          </div>
        </div>

        <TestNumbersPanel />

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">Audience batch(es)</label>
          <div className="space-y-2">
            {entry.sources.map((src) => (
              <div key={src.wsCode}>
                <p className="text-xs text-gray-500 mb-1">
                  {src.workshopName} · {src.audienceCount} registered
                </p>
                <div className="flex flex-wrap gap-2">
                  {src.batchDates.map((d) => (
                    <button
                      key={d}
                      onClick={() => removeBatch(src.wsCode, d)}
                      title="Remove this batch"
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-100 text-primary-700 border border-primary-300"
                    >
                      {d} ×
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {entry.audienceCount} registered contacts across {entry.sources.length} workshop
            {entry.sources.length === 1 ? "" : "s"} — duplicates removed by phone when the CSV is built
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">New workshop date</label>
            <input
              type="date"
              value={entry.promotedDate}
              onChange={(e) => onUpdate({ promotedDate: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Slot</label>
            <select
              value={entry.promotedTime}
              onChange={(e) => onUpdate({ promotedTime: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="11:00">11:00 AM</option>
              <option value="19:00">7:00 PM</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Zoom link</label>
            <input
              type="text"
              value={entry.zoomLink}
              onChange={(e) => onUpdate({ zoomLink: e.target.value })}
              placeholder="https://zoom.us/j/..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">WhatsApp group</label>
            <input
              type="text"
              value={entry.whatsappGroup}
              onChange={(e) => onUpdate({ whatsappGroup: e.target.value })}
              placeholder="https://chat.whatsapp.com/..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={onNext}
          disabled={entry.sources.length === 0 || !entry.promotedDate || !entry.targetWsCode}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
