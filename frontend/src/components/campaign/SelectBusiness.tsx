"use client";

import { useEffect, useState } from "react";
import { Business } from "@/types";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { apiRequest } from "@/lib/api";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
}

export default function SelectBusiness({ draft, onUpdate, onNext }: Props) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses")
      .then((data) => setBusinesses(data.businesses))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSelect = (business: Business) => {
    onUpdate({ business, selectedNumbers: [] });
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Select Business</h3>
      {loading ? (
        <p className="text-gray-500 text-sm">Loading businesses...</p>
      ) : businesses.length === 0 ? (
        <p className="text-gray-500 text-sm">No businesses configured.</p>
      ) : (
        <div className="space-y-3">
          {businesses.map((biz) => (
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
      )}
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
