"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api";
import { Business, PhoneNumber, Provider } from "@/types";
import { Plus } from "lucide-react";
import NumberFields, { emptyNumber } from "./NumberFields";

interface Props {
  business?: Business; // present when editing
}

export default function BusinessForm({ business }: Props) {
  const router = useRouter();
  const isEdit = Boolean(business);

  const [businessName, setBusinessName] = useState(business?.businessName || "");
  const [provider, setProvider] = useState<Provider>(business?.provider || "meta");
  const [accessToken, setAccessToken] = useState("");
  const [metaBusinessId, setMetaBusinessId] = useState(business?.metaBusinessId || "");
  const [numbers, setNumbers] = useState<PhoneNumber[]>(
    business?.phoneNumbers?.length ? business.phoneNumbers.map((n) => ({ ...n, apiKey: "" })) : [emptyNumber()]
  );
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const updateNumber = (index: number, updates: Partial<PhoneNumber>) => {
    setNumbers((prev) => prev.map((n, i) => (i === index ? { ...n, ...updates } : n)));
  };

  const addNumber = () => setNumbers((prev) => [...prev, emptyNumber()]);
  const removeNumber = (index: number) => setNumbers((prev) => prev.filter((_, i) => i !== index));

  const handleSubmit = async () => {
    setErrorMsg("");
    if (!businessName.trim()) return setErrorMsg("Business name is required");
    if (numbers.length === 0) return setErrorMsg("At least one number is required");

    for (const n of numbers) {
      if (!n.phoneNumberId.trim() || !n.displayName.trim()) {
        return setErrorMsg("Each number needs a name and ID");
      }
      if (provider === "meta" && !n.wabaid) return setErrorMsg(`"${n.displayName}" is missing a WABA ID`);
      if (provider !== "meta" && !n.apiKey && !n.hasApiKey) {
        return setErrorMsg(`"${n.displayName}" is missing an API key`);
      }
      if (provider === "wati" && !n.endpoint) return setErrorMsg(`"${n.displayName}" is missing a WATI endpoint URL`);
    }
    if (provider === "meta" && !accessToken && !business?.hasAccessToken) {
      return setErrorMsg("A Meta access token is required");
    }

    setSaving(true);
    try {
      const payload = {
        businessName: businessName.trim(),
        provider,
        accessToken: accessToken || undefined,
        metaBusinessId: metaBusinessId || undefined,
        phoneNumbers: numbers.map((n) => ({
          phoneNumberId: n.phoneNumberId.trim(),
          displayNumber: n.displayNumber.trim(),
          displayName: n.displayName.trim(),
          wabaid: provider === "meta" ? n.wabaid : undefined,
          apiKey: provider !== "meta" ? n.apiKey || undefined : undefined,
          source: provider === "aisensy" ? n.source : undefined,
          endpoint: provider === "wati" ? n.endpoint : undefined,
        })),
      };

      if (isEdit) {
        await apiRequest(`/businesses/${business!.businessId}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiRequest("/businesses", { method: "POST", body: JSON.stringify(payload) });
      }
      router.push("/businesses");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to save business");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 max-w-3xl">
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Business Name</label>
          <input
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
            disabled={isEdit}
            className="w-full text-sm border border-gray-300 rounded px-3 py-2 disabled:bg-gray-50 disabled:text-gray-400"
          >
            <option value="meta">Meta (WhatsApp Cloud API)</option>
            {/* AiSensy/WATI are only selectable when editing a business that's already on that
                provider — hidden for new businesses per current policy (Meta-only for now). */}
            {provider === "aisensy" && <option value="aisensy">AiSensy</option>}
            {provider === "wati" && <option value="wati">WATI</option>}
          </select>
          {isEdit && <p className="text-xs text-gray-400 mt-1">Provider can&apos;t be changed after creation.</p>}
        </div>
      </div>

      {provider === "meta" && (
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Meta Access Token {business?.hasAccessToken && <span className="text-green-600">(configured — leave blank to keep)</span>}
            </label>
            <input
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={business?.hasAccessToken ? "••••••••" : ""}
              className="w-full text-sm border border-gray-300 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Meta Business ID (optional)</label>
            <input
              type="text"
              value={metaBusinessId}
              onChange={(e) => setMetaBusinessId(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-3 py-2"
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-gray-900">Phone Numbers</h4>
        <button onClick={addNumber} className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium">
          <Plus className="w-3 h-3" /> Add Number
        </button>
      </div>

      <div className="space-y-3 mb-6">
        {numbers.map((n, i) => (
          <NumberFields
            key={i}
            provider={provider}
            number={n}
            onChange={(updates) => updateNumber(i, updates)}
            onRemove={numbers.length > 1 ? () => removeNumber(i) : undefined}
            autoDeriveId={!isEdit}
          />
        ))}
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
          {saving ? "Saving..." : isEdit ? "Save Changes" : "Create Business"}
        </button>
      </div>
    </div>
  );
}
