"use client";

import { CampaignDraft } from "@/app/campaigns/new/page";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onBack: () => void;
}

export default function ReviewSchedule({ draft, onUpdate, onBack }: Props) {
  const handleSchedule = async () => {
    // TODO: Upload CSV to S3, then call create campaign API
    alert(`Campaign "${draft.campaignPrefix}" scheduled!`);
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
          <span className="text-gray-500">Total Contacts</span>
          <span className="text-gray-900 font-medium">{draft.csvRowCount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Distribution</span>
          <span className="text-gray-900 font-medium">
            ~{Math.ceil(draft.csvRowCount / (draft.selectedNumbers.length || 1))} per number
          </span>
        </div>
      </div>

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={handleSchedule}
          disabled={!draft.campaignPrefix || !draft.scheduleDate || !draft.scheduleTime}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Schedule Campaign
        </button>
      </div>
    </div>
  );
}
