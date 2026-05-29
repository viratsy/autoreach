"use client";

import { PhoneNumber } from "@/types";
import { CampaignDraft } from "@/app/campaigns/new/page";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function SelectNumbers({ draft, onUpdate, onNext, onBack }: Props) {
  const numbers = draft.business?.phoneNumbers || [];

  const toggleNumber = (number: PhoneNumber) => {
    const exists = draft.selectedNumbers.find(
      (n) => n.phoneNumberId === number.phoneNumberId
    );
    if (exists) {
      onUpdate({
        selectedNumbers: draft.selectedNumbers.filter(
          (n) => n.phoneNumberId !== number.phoneNumberId
        ),
      });
    } else {
      onUpdate({ selectedNumbers: [...draft.selectedNumbers, number] });
    }
  };

  const selectAll = () => onUpdate({ selectedNumbers: numbers });

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Select Sending Numbers</h3>
        <button onClick={selectAll} className="text-sm text-primary-600 hover:text-primary-700">
          Select All
        </button>
      </div>
      <div className="space-y-2">
        {numbers.map((number) => {
          const isSelected = draft.selectedNumbers.some(
            (n) => n.phoneNumberId === number.phoneNumberId
          );
          return (
            <label
              key={number.phoneNumberId}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                isSelected ? "border-primary-500 bg-primary-50" : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleNumber(number)}
                className="w-4 h-4 text-primary-600 rounded"
              />
              <div>
                <p className="font-medium text-gray-900 text-sm">{number.displayName}</p>
                <p className="text-xs text-gray-500">{number.displayNumber}</p>
              </div>
            </label>
          );
        })}
      </div>
      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={onNext}
          disabled={draft.selectedNumbers.length === 0}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
