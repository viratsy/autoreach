"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { apiRequest } from "@/lib/api";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onBack: () => void;
}

export default function ReviewSchedule({ draft, onUpdate, onBack }: Props) {
  const router = useRouter();
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState("");

  const handleSchedule = async () => {
    // Validate schedule is at least 5 minutes in the future
    const now = new Date();
    const scheduled = new Date(`${draft.scheduleDate}T${draft.scheduleTime}:00`);
    const minTime = new Date(now.getTime() + 5 * 60 * 1000);

    if (scheduled < minTime) {
      setError("Schedule must be at least 5 minutes from now");
      return;
    }

    setScheduling(true);
    setError("");

    try {
      const result = await apiRequest<{ campaignId: string; campaignName: string }>(
        "/campaigns",
        {
          method: "POST",
          body: JSON.stringify({
            campaignPrefix: draft.campaignPrefix,
            businessId: draft.business!.businessId,
            businessName: draft.business!.businessName,
            selectedNumbers: draft.selectedNumbers,
            templateName: draft.template!.templateName,
            templateCategory: draft.template!.category,
            templateMappings: draft.templateMappings,
            parameterMapping: draft.parameterMapping,
            headerImageUrl: draft.headerImageUrl || undefined,
            numbersWithImageHeader: draft.numbersWithImageHeader,
            csvS3Key: draft.csvS3Key,
            totalContacts: draft.csvRowCount,
            scheduleDate: draft.scheduleDate,
            scheduleTime: draft.scheduleTime,
          }),
        }
      );

      // Redirect to campaigns list with success
      router.push("/campaigns");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule campaign");
    } finally {
      setScheduling(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Review & Schedule</h3>

      {/* Campaign Name */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">Campaign Name Prefix</label>
        <input
          type="text"
          value={draft.campaignPrefix}
          onChange={(e) => onUpdate({ campaignPrefix: e.target.value })}
          placeholder="e.g. diwali_offer"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
        <p className="text-xs text-gray-400 mt-1">
          Final name: {draft.campaignPrefix || "campaign"}_xxxxxx
        </p>
      </div>

      {/* Schedule */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Schedule Date</label>
          <input
            type="date"
            value={draft.scheduleDate}
            onChange={(e) => onUpdate({ scheduleDate: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Schedule Time</label>
          <input
            type="time"
            value={draft.scheduleTime}
            onChange={(e) => onUpdate({ scheduleTime: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>

      {/* Summary */}
      <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Business</span>
          <span className="text-gray-900 font-medium">{draft.business?.businessName}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Sending Numbers</span>
          <span className="text-gray-900 font-medium">{draft.selectedNumbers.length}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Template</span>
          <span className="text-gray-900 font-medium">{draft.template?.templateName}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Category</span>
          <span className={`font-medium ${draft.template?.category === "MARKETING" ? "text-red-600" : "text-green-600"}`}>
            {draft.template?.category || "UTILITY"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Parameters</span>
          <span className="text-gray-900 font-medium">{draft.template?.parameterCount} body params{draft.headerImageUrl ? " + image header" : ""}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Total Contacts</span>
          <span className="text-gray-900 font-medium">{draft.csvRowCount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Distribution</span>
          <span className="text-gray-900 font-medium">
            ~{Math.ceil(draft.csvRowCount / (draft.selectedNumbers.length || 1))} per number
          </span>
        </div>
        <div className="border-t border-gray-200 pt-2 mt-2">
          <div className="flex justify-between">
            <span className="text-gray-500">Estimated Cost</span>
            <span className="text-gray-900 font-bold">
              ₹{((draft.template?.category === "MARKETING" ? 0.8631 : 0.115) * draft.csvRowCount).toFixed(2)}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {draft.template?.category === "MARKETING" ? "₹0.8631" : "₹0.115"}/msg × {draft.csvRowCount} contacts (charged on delivery)
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={handleSchedule}
          disabled={!draft.campaignPrefix || !draft.scheduleDate || !draft.scheduleTime || scheduling}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          {scheduling ? "Scheduling..." : "Schedule Campaign"}
        </button>
      </div>
    </div>
  );
}
