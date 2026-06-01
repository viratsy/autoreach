"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Save, Plus, Trash2, Info } from "lucide-react";

interface WorkshopConfig {
  wsCode: string;
  cycle: number;
  customParams?: Record<string, string>;
}

const DB_PARAMS = [
  { key: "name", description: "Contact name from registration", example: "Virat" },
  { key: "phone", description: "Phone number", example: "+918427051955" },
  { key: "email", description: "Email address", example: "virat@email.com" },
  { key: "zoom_link", description: "Zoom meeting link from batch details", example: "https://zoom.us/j/98809613024" },
  { key: "whatsapp_group", description: "WhatsApp group link from batch details", example: "https://chat.whatsapp.com/FByBaP..." },
  { key: "workshop_name", description: "Workshop name", example: "Generative AI Tools" },
  { key: "workshop_date", description: "Workshop date", example: "2026-06-03" },
  { key: "workshop_time", description: "Workshop time", example: "07:00 PM IST" },
];

const COMPUTED_PARAMS = [
  { key: "full_workshop_name", description: "3 Hours Live {workshop_name} Workshop", example: "3 Hours Live Generative AI Tools Workshop" },
  { key: "workshop_name_w", description: "{workshop_name} Workshop", example: "Generative AI Tools Workshop" },
  { key: "workshop_date_time", description: "{workshop_date} at {workshop_time}", example: "2026-06-03 at 07:00 PM IST" },
  { key: "workshop_time_short", description: "Time without IST suffix", example: "07:00 PM" },
  { key: "mentor_name", description: "Static mentor name", example: "Hardik Raja (Your Mentor)" },
  { key: "w_type", description: "Always 'Workshop'", example: "Workshop" },
  { key: "w_name", description: "Short workshop name (without '3 Hour Live')", example: "Generative AI Tools" },
  { key: "w_date", description: "Workshop date formatted as '5th June'", example: "5th June" },
  { key: "three_hours_text", description: "3 hours live {workshop_name}", example: "3 hours live Generative AI Tools" },
  { key: "duration", description: "{workshop_time} to {workshop_time + 3 hours} IST", example: "7:00 PM to 10:00 PM IST" },
];

const WORKSHOP_CODES = ["aitools", "msai", "aidash", "aibuild"];

export default function WorkshopParamsPage() {
  const [wsCode, setWsCode] = useState("aitools");
  const [customParams, setCustomParams] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  useEffect(() => { loadParams(); }, [wsCode]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3000); return () => clearTimeout(t); } }, [toast]);

  const loadParams = async () => {
    try {
      const data = await apiRequest<{ config: WorkshopConfig | null }>(`/workshops/config?wsCode=${wsCode}&cycle=0`);
      setCustomParams(data.config?.customParams || {});
    } catch { setCustomParams({}); }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Load existing config and update just customParams
      const data = await apiRequest<{ config: WorkshopConfig | null }>(`/workshops/config?wsCode=${wsCode}&cycle=0`);
      const existing = data.config || { wsCode, workshopName: wsCode, cycle: 0, businessId: "", numbers: {}, runKeys: {} };
      await apiRequest("/workshops/config", {
        method: "PUT",
        body: JSON.stringify({ ...existing, customParams }),
      });
      setToast("✓ Parameters saved");
    } catch { setToast("✗ Save failed"); }
    finally { setSaving(false); }
  };

  const addParam = () => {
    if (!newKey.trim()) return;
    setCustomParams({ ...customParams, [newKey.trim()]: newValue });
    setNewKey(""); setNewValue("");
  };

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Workshop Parameters</h2>
                <p className="text-sm text-gray-500 mt-1">Manage variables used in template mapping</p>
              </div>
              <div className="flex items-center gap-3">
                <select value={wsCode} onChange={(e) => setWsCode(e.target.value)} className="bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm font-medium shadow-sm">
                  {WORKSHOP_CODES.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>
                <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-primary-700 shadow-sm">
                  <Save className="w-4 h-4" />
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            {/* DB Parameters */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm mb-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">From Registration (Dynamic)</h3>
              </div>
              <p className="text-xs text-gray-400 mb-4">These values come from the user&apos;s registration data. Available automatically.</p>
              <div className="grid gap-2">
                {DB_PARAMS.map((p) => (
                  <div key={p.key} className="flex items-center gap-4 py-2 px-3 rounded-lg hover:bg-gray-50">
                    <code className="text-xs font-mono bg-green-50 text-green-700 px-2.5 py-1 rounded-md border border-green-100 min-w-[140px]">{p.key}</code>
                    <span className="text-xs text-gray-500 flex-1">{p.description}</span>
                    <span className="text-xs text-gray-300 italic">{p.example}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Computed Parameters */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm mb-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-purple-500"></div>
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Computed (Auto-generated)</h3>
              </div>
              <p className="text-xs text-gray-400 mb-4">These are automatically calculated from the DB values. No setup needed.</p>
              <div className="grid gap-2">
                {COMPUTED_PARAMS.map((p) => (
                  <div key={p.key} className="flex items-center gap-4 py-2 px-3 rounded-lg hover:bg-gray-50">
                    <code className="text-xs font-mono bg-purple-50 text-purple-700 px-2.5 py-1 rounded-md border border-purple-100 min-w-[180px]">{p.key}</code>
                    <span className="text-xs text-gray-500 flex-1">{p.description}</span>
                    <span className="text-xs text-gray-300 italic">{p.example}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Custom Parameters */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Custom Static (User-defined)</h3>
              </div>
              <p className="text-xs text-gray-400 mb-4">Define your own static values. These are the same for every contact in the campaign.</p>

              <div className="space-y-3 mb-4">
                {Object.entries(customParams).map(([key, value]) => (
                  <div key={key} className="flex items-start gap-3 group bg-gray-50 rounded-xl p-3">
                    <code className="text-xs font-mono bg-blue-50 text-blue-700 px-2.5 py-1.5 rounded-md border border-blue-100 min-w-[140px] mt-0.5">{key}</code>
                    <textarea
                      value={value}
                      onChange={(e) => setCustomParams({ ...customParams, [key]: e.target.value })}
                      rows={2}
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm resize-y focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                    <button onClick={() => { const cp = { ...customParams }; delete cp[key]; setCustomParams(cp); }} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 mt-1.5 transition-opacity">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}

                {Object.keys(customParams).length === 0 && (
                  <p className="text-center text-gray-300 py-4 text-sm">No custom parameters yet</p>
                )}
              </div>

              {/* Add new */}
              <div className="flex items-start gap-3 pt-4 border-t border-gray-100">
                <input type="text" value={newKey} onChange={(e) => setNewKey(e.target.value.replace(/\s/g, "_").toLowerCase())} placeholder="param_key" className="border border-gray-200 rounded-lg px-3 py-2.5 text-sm w-40 font-mono focus:ring-2 focus:ring-primary-500" />
                <input type="text" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="Static value that will be used in templates..." className="flex-1 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-primary-500" />
                <button onClick={addParam} disabled={!newKey.trim()} className="px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                  <Plus className="w-4 h-4" /> Add
                </button>
              </div>

              <div className="mt-4 p-3 bg-amber-50 rounded-lg border border-amber-100 flex items-start gap-2">
                <Info className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-amber-700">Custom params appear with ⚡ in the template config dropdown. They&apos;re sent as-is (same value for every contact).</p>
              </div>
            </div>
          </div>

          {toast && <div className="fixed bottom-6 right-6 px-5 py-3 rounded-xl shadow-lg text-sm font-medium bg-gray-900 text-white z-50">{toast}</div>}
        </main>
      </div>
    </AuthGuard>
  );
}
