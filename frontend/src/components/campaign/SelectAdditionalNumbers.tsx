"use client";

import { useEffect, useState } from "react";
import { PhoneNumber } from "@/types";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { apiRequest } from "@/lib/api";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

interface TemplateAvailability {
  templateName: string;
  availableOn: string[];
  categoryPerNumber?: Record<string, string>;
  hasImageHeaderPerNumber?: Record<string, boolean>;
}

/**
 * Expands the sending pool beyond the one main number already validated
 * against the chosen template. Only offers numbers where that exact
 * template is approved as UTILITY — MARKETING carries stricter sending
 * windows and higher cost, and numbers without the template at all can't
 * send it — so instead of the old flow's after-the-fact "map an
 * alternative or skip" cleanup, ineligible numbers are just never
 * selectable here in the first place.
 */
export default function SelectAdditionalNumbers({ draft, onUpdate, onNext, onBack }: Props) {
  const [availability, setAvailability] = useState<TemplateAvailability | null>(null);
  const [loading, setLoading] = useState(true);

  const allNumbers = draft.business?.phoneNumbers || [];
  const mainNumberId = draft.selectedNumbers[0]?.phoneNumberId;
  const otherNumbers = allNumbers.filter((n) => n.phoneNumberId !== mainNumberId);

  useEffect(() => {
    loadAvailability();
  }, []);

  const loadAvailability = async () => {
    if (!draft.business || !draft.template) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        businessId: draft.business.businessId,
        phoneNumberIds: allNumbers.map((n) => n.phoneNumberId).join(","),
      });
      const data = await apiRequest<{ templates: TemplateAvailability[] }>(`/templates?${params}`);
      const tpl = data.templates.find((t) => t.templateName === draft.template!.templateName);
      setAvailability(tpl || { templateName: draft.template.templateName, availableOn: [], categoryPerNumber: {} });
    } catch {
      setAvailability(null);
    } finally {
      setLoading(false);
    }
  };

  const isEligible = (number: PhoneNumber) =>
    !!availability?.availableOn.includes(number.phoneNumberId) &&
    availability?.categoryPerNumber?.[number.phoneNumberId] !== "MARKETING";

  const ineligibleReason = (number: PhoneNumber) => {
    if (!availability?.availableOn.includes(number.phoneNumberId)) return "Doesn't have this template";
    if (availability?.categoryPerNumber?.[number.phoneNumberId] === "MARKETING") return "MARKETING only";
    return "";
  };

  const toggleNumber = (number: PhoneNumber) => {
    if (!isEligible(number)) return;
    const exists = draft.selectedNumbers.some((n) => n.phoneNumberId === number.phoneNumberId);
    onUpdate({
      selectedNumbers: exists
        ? draft.selectedNumbers.filter((n) => n.phoneNumberId !== number.phoneNumberId)
        : [...draft.selectedNumbers, number],
    });
  };

  const selectAllEligible = () => {
    const eligible = otherNumbers.filter(isEligible);
    const mainNumber = draft.selectedNumbers.find((n) => n.phoneNumberId === mainNumberId);
    onUpdate({ selectedNumbers: mainNumber ? [mainNumber, ...eligible] : eligible });
  };

  const eligibleCount = otherNumbers.filter(isEligible).length;

  // numbersWithImageHeader was only ever set once, back in SelectTemplate.tsx,
  // from whichever numbers were selected at that point — just the main
  // number, since this step (adding the rest) hadn't run yet. Recompute it
  // here from the full per-number data this step already fetched for every
  // number on the business, so a number added here that has its own
  // image-header version of the template actually gets one sent — otherwise
  // Meta rejects the send with "header: Format mismatch, expected IMAGE,
  // received UNKNOWN" for every number besides the main one.
  const handleNext = () => {
    const numbersWithImageHeader = draft.selectedNumbers
      .filter((n) => availability?.hasImageHeaderPerNumber?.[n.phoneNumberId] === true)
      .map((n) => n.phoneNumberId);
    onUpdate({ numbersWithImageHeader });
    onNext();
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-lg font-semibold text-gray-900">Add More Sending Numbers</h3>
        {eligibleCount > 0 && (
          <button onClick={selectAllEligible} className="text-sm text-primary-600 hover:text-primary-700">
            Select All Eligible
          </button>
        )}
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Optional — only numbers with <span className="font-medium">{draft.template?.templateName}</span> approved as UTILITY are selectable.
      </p>

      {loading ? (
        <p className="text-gray-500 text-sm py-4">Checking template availability...</p>
      ) : otherNumbers.length === 0 ? (
        <p className="text-gray-400 text-sm py-4">No other numbers on this business.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-96 overflow-y-auto border border-gray-100 rounded-lg p-3">
          {otherNumbers.map((number) => {
            const eligible = isEligible(number);
            const isSelected = draft.selectedNumbers.some((n) => n.phoneNumberId === number.phoneNumberId);
            return (
              <label
                key={number.phoneNumberId}
                className={`flex items-start gap-2 p-2.5 rounded-lg border transition-colors ${
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
                  onChange={() => toggleNumber(number)}
                  className="w-4 h-4 mt-0.5 text-primary-600 rounded disabled:opacity-50 shrink-0"
                />
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 text-sm truncate">{number.displayName}</p>
                  <p className="text-xs text-gray-500 truncate">{number.displayNumber}</p>
                  {!eligible && (
                    <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 bg-gray-200 text-gray-500 rounded font-medium">
                      {ineligibleReason(number)}
                    </span>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={handleNext}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          Next ({draft.selectedNumbers.length} number{draft.selectedNumbers.length !== 1 ? "s" : ""})
        </button>
      </div>
    </div>
  );
}
