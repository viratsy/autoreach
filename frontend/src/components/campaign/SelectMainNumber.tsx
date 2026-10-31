"use client";

import { PhoneNumber } from "@/types";
import { CampaignDraft } from "@/app/campaigns/new/page";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * Picks the one number the template gets validated against next — not the
 * full sending pool. Discovering "this number doesn't have that template"
 * used to happen after numbers, CSV, and everything else were already
 * filled in; picking one number first and checking the template against it
 * immediately (next step) surfaces that failure before any of the rest of
 * the wizard is touched. More numbers get added afterward, once a template
 * is confirmed to actually work.
 */
export default function SelectMainNumber({ draft, onUpdate, onNext, onBack }: Props) {
  const numbers = draft.business?.phoneNumbers || [];
  const selected = draft.selectedNumbers[0];

  const selectNumber = (number: PhoneNumber) => {
    if (selected?.phoneNumberId === number.phoneNumberId) return;
    // Changing the main number invalidates whatever template was already
    // chosen against the old one.
    onUpdate({
      selectedNumbers: [number],
      template: draft.selectedNumbers.length ? null : draft.template,
      templateMappings: {},
      numbersWithImageHeader: [],
    });
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">Select Main Number</h3>
      <p className="text-sm text-gray-500 mb-4">
        The template you pick next gets checked against this number first. You can add more sending numbers afterward.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-96 overflow-y-auto border border-gray-100 rounded-lg p-3">
        {numbers.map((number) => {
          const isSelected = selected?.phoneNumberId === number.phoneNumberId;
          return (
            <label
              key={number.phoneNumberId}
              className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                isSelected ? "border-primary-500 bg-primary-50" : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <input
                type="radio"
                name="mainNumber"
                checked={isSelected}
                onChange={() => selectNumber(number)}
                className="w-4 h-4 text-primary-600 shrink-0"
              />
              <div className="min-w-0">
                <p className="font-medium text-gray-900 text-sm truncate">{number.displayName}</p>
                <p className="text-xs text-gray-500 truncate">{number.displayNumber}</p>
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
