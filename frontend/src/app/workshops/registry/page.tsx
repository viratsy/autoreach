"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import { Plus, Trash2, Save } from "lucide-react";

interface Workshop {
  code: string;
  displayName: string;
  aliases: string[];
  time: string;
  runKeys: string[];
  mentorName: string;
}

const ALL_RUN_KEYS = [
  "2days_to_go", "1day_to_go", "9am_groupjoin", "1pm_group_join", "2_30_group_join", "3pm_group_join",
  "60_mins_to_go", "20_mins_to_go", "we_are_live",
  "its_7_pm", "its_7_10_pm", "its_7_20_pm", "its_7_30_pm",
  "its_11_am", "its_11_10_am", "its_11_20_am", "its_11_30_am",
  "the_day_is_here",
];

const RUN_KEYS_7PM = [
  "2days_to_go", "1day_to_go", "9am_groupjoin", "1pm_group_join", "2_30_group_join", "3pm_group_join",
  "60_mins_to_go", "20_mins_to_go", "we_are_live",
  "its_7_pm", "its_7_10_pm", "its_7_20_pm", "its_7_30_pm", "the_day_is_here",
];

const RUN_KEYS_11AM = [
  "2days_to_go", "1day_to_go", "9am_groupjoin",
  "60_mins_to_go", "20_mins_to_go", "we_are_live",
  "its_11_am", "its_11_10_am", "its_11_20_am", "its_11_30_am", "the_day_is_here",
];

export default function WorkshopRegistryPage() {
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [editing, setEditing] = useState<Workshop | null>(null);
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [newAlias, setNewAlias] = useState("");

  useEffect(() => { loadWorkshops(); }, []);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3000); return () => clearTimeout(t); } }, [toast]);

  const loadWorkshops = async () => {
    try {
      const data = await apiRequest<{ workshops: Workshop[] }>("/workshops/registry");
      setWorkshops(data.workshops);
    } catch {}
  };

  const handleSave = async () => {
    if (!editing || !editing.code) { setToast("Code is required"); return; }
    setSaving(true);
    try {
      await apiRequest("/workshops/registry", { method: "PUT", body: JSON.stringify(editing) });
      setToast("✓ Saved");
      setEditing(null);
      loadWorkshops();
    } catch { setToast("✗ Failed"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (code: string) => {
    try {
      await apiRequest(`/workshops/registry?code=${code}`, { method: "DELETE" });
      setToast("✓ Deleted");
      loadWorkshops();
    } catch { setToast("✗ Failed"); }
  };

  const addAlias = () => {
    if (!editing || !newAlias.trim()) return;
    setEditing({ ...editing, aliases: [...(editing.aliases || []), newAlias.trim()] });
    setNewAlias("");
  };

  const removeAlias = (idx: number) => {
    if (!editing) return;
    setEditing({ ...editing, aliases: editing.aliases.filter((_, i) => i !== idx) });
  };

  const setTimePreset = (time: string) => {
    if (!editing) return;
    const keys = time === "7pm" ? RUN_KEYS_7PM : RUN_KEYS_11AM;
    setEditing({ ...editing, time, runKeys: keys });
  };

  const toggleRunKey = (rk: string) => {
    if (!editing) return;
    const current = editing.runKeys || [];
    const updated = current.includes(rk) ? current.filter((k) => k !== rk) : [...current, rk];
    setEditing({ ...editing, runKeys: updated });
  };

  const startNew = () => {
    setEditing({ code: "", displayName: "", aliases: [], time: "7pm", runKeys: RUN_KEYS_7PM, mentorName: "" });
  };

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Workshop Registry</h2>
                <p className="text-sm text-gray-500 mt-1">Map workshop names, codes, times, and run keys</p>
              </div>
              <button onClick={startNew} className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl text-sm font-medium hover:bg-primary-700">
                <Plus className="w-4 h-4" /> Add Workshop
              </button>
            </div>

            {/* Workshop List */}
            <div className="space-y-3 mb-8">
              {workshops.map((ws) => (
                <div key={ws.code} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{ws.displayName}</span>
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-mono">{ws.code}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ws.time === "7pm" ? "bg-indigo-100 text-indigo-700" : "bg-amber-100 text-amber-700"}`}>
                        {ws.time === "7pm" ? "7 PM" : "11 AM"}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      Aliases: {(ws.aliases || []).join(", ") || "none"} • {(ws.runKeys || []).length} run keys • Mentor: {ws.mentorName || "-"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setEditing({ ...ws })} className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">Edit</button>
                    <button onClick={() => handleDelete(ws.code)} className="p-1.5 text-red-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
              {workshops.length === 0 && <p className="text-center text-gray-400 text-sm py-8">No workshops registered yet</p>}
            </div>

            {/* Edit Panel */}
            {editing && (
              <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
                  {editing.code ? `Edit: ${editing.code}` : "New Workshop"}
                </h3>

                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Code (unique ID)</label>
                    <input type="text" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} placeholder="aitools" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Display Name</label>
                    <input type="text" value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} placeholder="Generative AI Tools" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Mentor Name</label>
                    <input type="text" value={editing.mentorName} onChange={(e) => setEditing({ ...editing, mentorName: e.target.value })} placeholder="Hardik Raja" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Workshop Time</label>
                    <div className="flex gap-2">
                      <button onClick={() => setTimePreset("7pm")} className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border ${editing.time === "7pm" ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-600 border-gray-200"}`}>7 PM</button>
                      <button onClick={() => setTimePreset("11am")} className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border ${editing.time === "11am" ? "bg-amber-500 text-white border-amber-500" : "bg-white text-gray-600 border-gray-200"}`}>11 AM</button>
                    </div>
                  </div>
                </div>

                {/* Aliases */}
                <div className="mb-4">
                  <label className="text-xs font-medium text-gray-600 mb-2 block">Name Aliases (used to match incoming registrations)</label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {(editing.aliases || []).map((alias, idx) => (
                      <span key={idx} className="flex items-center gap-1 px-2.5 py-1 bg-blue-50 text-blue-700 rounded-lg text-xs font-medium">
                        {alias}
                        <button onClick={() => removeAlias(idx)} className="text-blue-400 hover:text-blue-600">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input type="text" value={newAlias} onChange={(e) => setNewAlias(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addAlias()} placeholder="Add alias name..." className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm" />
                    <button onClick={addAlias} className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 border border-blue-200">Add</button>
                  </div>
                </div>

                {/* Run Keys */}
                <div className="mb-4">
                  <label className="text-xs font-medium text-gray-600 mb-2 block">Active Run Keys</label>
                  <div className="flex flex-wrap gap-2">
                    {ALL_RUN_KEYS.map((rk) => (
                      <button key={rk} onClick={() => toggleRunKey(rk)} className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${(editing.runKeys || []).includes(rk) ? "bg-primary-100 text-primary-700 border border-primary-300" : "bg-gray-100 text-gray-400 border border-gray-200 line-through"}`}>
                        {rk}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <button onClick={() => setEditing(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
                  <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-5 py-2 bg-primary-600 text-white rounded-xl text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
                    <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            )}

            {toast && <div className="fixed bottom-6 right-6 px-5 py-3 rounded-xl shadow-lg text-sm font-medium bg-gray-900 text-white z-50">{toast}</div>}
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
