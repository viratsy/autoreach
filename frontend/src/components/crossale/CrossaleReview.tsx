"use client";

import { useState } from "react";
import { apiRequest } from "@/lib/api";
import { WorkshopEntry, CreatedCampaign } from "@/app/crossale/page";

interface Props {
  entry: WorkshopEntry;
  onCreated: (result: { created: Omit<CreatedCampaign, "workshopName">[]; warnings: string[] }) => void;
  onBack: () => void;
}

function computeSendMoment(entry: WorkshopEntry, offsetMinutes: number): Date {
  const promoted = new Date(`${entry.promotedDate}T${entry.promotedTime}:00+05:30`);
  return new Date(promoted.getTime() - offsetMinutes * 60000);
}

export default function CrossaleReview({ entry, onCreated, onBack }: Props) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const selected = entry.runKeys.filter((r) => r.selected);
  const now = Date.now();

  const create = async () => {
    setCreating(true);
    setError("");
    try {
      const result = await apiRequest<{ created: Omit<CreatedCampaign, "workshopName">[]; warnings: string[] }>(
        "/crossale/create",
        {
          method: "POST",
          body: JSON.stringify({

            targetWsCode: entry.targetWsCode,
            targetWorkshopName: entry.targetWorkshopName,
            businessId: entry.businessId,
            sources: entry.sources.map((src) => ({ wsCode: src.wsCode, batchDates: src.batchDates })),
            promotedDate: entry.promotedDate,
            promotedTime: entry.promotedTime,
            zoomLink: entry.zoomLink,
            whatsappGroup: entry.whatsappGroup,
            selectedNumberIds:
              entry.mode === "manual"
                ? Array.from(new Set(selected.flatMap((r) => r.numberIds || [])))
                : undefined,
            runKeys: selected.map((r) => ({
              runKey: r.runKey,
              templateName: r.templateName,
              bodyParams: r.bodyParams,
              headerImageUrl: r.headerImageUrl,
              offsetMinutes: r.offsetMinutes,
            })),
          }),
        }
      );
      onCreated(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create campaigns");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">Review — {entry.targetWorkshopName}</h3>
      <p className="text-sm text-gray-500 mb-4">
        {entry.audienceCount} registered contacts from{" "}
        {entry.sources.map((src) => src.workshopName).join(", ")} · promoted to {entry.promotedDate}{" "}
        {entry.promotedTime === "19:00" ? "7:00 PM" : "11:00 AM"}
      </p>

      <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg mb-4">
        {selected.map((rk) => {
          const sendMoment = computeSendMoment(entry, rk.offsetMinutes);
          const isPast = sendMoment.getTime() <= now;
          return (
            <div key={rk.runKey} className="px-4 py-3 flex items-center justify-between text-sm">
              <div>
                <p className="font-medium text-gray-900">{rk.runKey}</p>
                <p className="text-xs text-gray-400 font-mono">{rk.templateName}</p>
              </div>
              <div className="text-right">
                <p className={isPast ? "text-red-500 font-medium" : "text-gray-700"}>
                  {sendMoment.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}
                </p>
                {isPast && <p className="text-xs text-red-400">Already past — will be skipped</p>}
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={create}
          disabled={creating || selected.length === 0}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          {creating ? "Creating..." : `Create ${selected.length} Campaign${selected.length !== 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );
}
