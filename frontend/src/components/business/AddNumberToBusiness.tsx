"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api";
import { Business, PhoneNumber } from "@/types";
import NumberFields, { emptyNumber } from "./NumberFields";

interface Props {
  businesses: Business[];
}

export default function AddNumberToBusiness({ businesses }: Props) {
  const router = useRouter();
  const [businessId, setBusinessId] = useState(businesses[0]?.businessId || "");
  const [number, setNumber] = useState<PhoneNumber>(emptyNumber());
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const business = businesses.find((b) => b.businessId === businessId);
  const provider = business?.provider || "meta";

  const handleSubmit = async () => {
    setErrorMsg("");
    if (!business) return setErrorMsg("Select a business");
    if (!number.phoneNumberId.trim() || !number.displayName.trim()) {
      return setErrorMsg("The number needs a name and ID");
    }
    if (provider === "meta" && !number.wabaid) return setErrorMsg("A WABA ID is required");
    if (provider !== "meta" && !number.apiKey) return setErrorMsg("An API key is required");
    if (provider === "wati" && !number.endpoint) return setErrorMsg("A WATI endpoint URL is required");

    setSaving(true);
    try {
      // Resend the business's existing numbers as-is (secrets omitted — the backend
      // preserves them by matching phoneNumberId) plus the new one being added.
      const phoneNumbers = [
        ...business.phoneNumbers,
        {
          phoneNumberId: number.phoneNumberId.trim(),
          displayNumber: number.displayNumber.trim(),
          displayName: number.displayName.trim(),
          wabaid: provider === "meta" ? number.wabaid : undefined,
          apiKey: provider !== "meta" ? number.apiKey : undefined,
          source: provider === "aisensy" ? number.source : undefined,
          endpoint: provider === "wati" ? number.endpoint : undefined,
        },
      ];

      await apiRequest(`/businesses/${business.businessId}`, {
        method: "PUT",
        body: JSON.stringify({
          businessName: business.businessName,
          provider,
          metaBusinessId: business.metaBusinessId,
          phoneNumbers,
        }),
      });
      router.push("/businesses");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to add number");
    } finally {
      setSaving(false);
    }
  };

  if (businesses.length === 0) {
    return <p className="text-sm text-gray-500">No businesses exist yet — create one first.</p>;
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 max-w-3xl">
      <div className="mb-6">
        <label className="block text-xs text-gray-500 mb-1">Business</label>
        <select
          value={businessId}
          onChange={(e) => {
            setBusinessId(e.target.value);
            setNumber(emptyNumber());
          }}
          className="w-full text-sm border border-gray-300 rounded px-3 py-2"
        >
          {businesses.map((b) => (
            <option key={b.businessId} value={b.businessId}>
              {b.businessName} ({b.provider || "meta"})
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-400 mt-1">
          The existing access token / API keys on this business will be reused — no need to re-enter them.
        </p>
      </div>

      <h4 className="text-sm font-semibold text-gray-900 mb-2">New Number</h4>
      <div className="mb-6">
        <NumberFields provider={provider} number={number} onChange={(u) => setNumber((prev) => ({ ...prev, ...u }))} autoDeriveId />
      </div>

      {errorMsg && <p className="text-sm text-red-600 mb-4">{errorMsg}</p>}

      <div className="flex justify-end gap-3">
        <button onClick={() => router.push("/businesses")} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-primary-700"
        >
          {saving ? "Adding..." : "Add Number"}
        </button>
      </div>
    </div>
  );
}
