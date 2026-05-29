"use client";

import { Business } from "@/types";
import { CampaignDraft } from "@/app/campaigns/new/page";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
}

// Mock data — replace with API call
const mockBusinesses: Business[] = [
  {
    businessId: "biz_001",
    businessName: "Business 1",
    wabaId: "waba_001",
    phoneNumbers: [
      { phoneNumberId: "pn_a", displayNumber: "+91 98765 43210", displayName: "Number A" },
      { phoneNumberId: "pn_b", displayNumber: "+91 98765 43211", displayName: "Number B" },
      { phoneNumberId: "pn_c", displayNumber: "+91 98765 43212", displayName: "Number C" },
    ],
    createdAt: "",
    updatedAt: "",
  },
  {
    businessId: "biz_002",
    businessName: "Business 2",
    wabaId: "waba_002",
    phoneNumbers: [
      { phoneNumberId: "pn_d", displayNumber: "+91 98765 43213", displayName: "Number D" },
      { phoneNumberId: "pn_e", displayNumber: "+91 98765 43214", displayName: "Number E" },
    ],
    createdAt: "",
    updatedAt: "",
  },
];

export default function SelectBusiness({ draft, onUpdate, onNext }: Props) {
  const handleSelect = (business: Business) => {
    onUpdate({ business, selectedNumbers: [] });
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Select Business</h3>
      <div className="space-y-3">
        {mockBusinesses.map((biz) => (
          <button
            key={biz.businessId}
            onClick={() => handleSelect(biz)}
            className={`w-full text-left p-4 rounded-lg border transition-colors ${
              draft.business?.businessId === biz.businessId
                ? "border-primary-500 bg-primary-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <p className="font-medium text-gray-900">{biz.businessName}</p>
            <p className="text-sm text-gray-500 mt-1">
              {biz.phoneNumbers.length} phone number{biz.phoneNumbers.length !== 1 ? "s" : ""}
            </p>
          </button>
        ))}
      </div>
      <div className="mt-6 flex justify-end">
        <button
          onClick={onNext}
          disabled={!draft.business}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
