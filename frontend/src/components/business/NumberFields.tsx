"use client";

import { PhoneNumber, Provider } from "@/types";
import { Trash2 } from "lucide-react";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function emptyNumber(): PhoneNumber {
  return { phoneNumberId: "", displayNumber: "", displayName: "" };
}

interface Props {
  provider: Provider;
  number: PhoneNumber;
  onChange: (updates: Partial<PhoneNumber>) => void;
  onRemove?: () => void;
  autoDeriveId?: boolean; // auto-fill phoneNumberId from displayName as the user types (new numbers only)
}

export default function NumberFields({ provider, number: n, onChange, onRemove, autoDeriveId }: Props) {
  const handleDisplayNameChange = (value: string) => {
    const updates: Partial<PhoneNumber> = { displayName: value };
    if (provider !== "meta" && autoDeriveId) {
      updates.phoneNumberId = `${provider}_${slugify(value)}`;
    }
    onChange(updates);
  };

  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <div className="grid grid-cols-2 gap-3 mb-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Display Name</label>
          <input
            type="text"
            value={n.displayName}
            onChange={(e) => handleDisplayNameChange(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Display Number</label>
          <input
            type="text"
            value={n.displayNumber}
            onChange={(e) => onChange({ displayNumber: e.target.value })}
            className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
          />
        </div>
      </div>

      {provider === "meta" ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Phone Number ID (Meta)</label>
            <input
              type="text"
              value={n.phoneNumberId}
              onChange={(e) => onChange({ phoneNumberId: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">WABA ID</label>
            <input
              type="text"
              value={n.wabaid || ""}
              onChange={(e) => onChange({ wabaid: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              API Key {n.hasApiKey && <span className="text-green-600">(configured — leave blank to keep)</span>}
            </label>
            <input
              type="password"
              value={n.apiKey || ""}
              onChange={(e) => onChange({ apiKey: e.target.value })}
              placeholder={n.hasApiKey ? "••••••••" : ""}
              className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
            />
          </div>
          {provider === "aisensy" ? (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Source Label</label>
              <input
                type="text"
                value={n.source || ""}
                onChange={(e) => onChange({ source: e.target.value })}
                className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs text-gray-500 mb-1">WATI Endpoint URL</label>
              <input
                type="text"
                value={n.endpoint || ""}
                onChange={(e) => onChange({ endpoint: e.target.value })}
                placeholder="https://live-mt-server.wati.io/xxxxx"
                className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
              />
            </div>
          )}
        </div>
      )}

      {onRemove && (
        <button onClick={onRemove} className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 mt-2">
          <Trash2 className="w-3 h-3" /> Remove
        </button>
      )}
    </div>
  );
}
