"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { FlaskConical, Plus, X } from "lucide-react";

interface TestNumber {
  name: string;
  phone: string;
}

/**
 * The shared QA/team numbers that ride along in every Crossale and
 * current-batch audience (backend: lib/test-numbers.ts) — one list per AWS
 * account, so adding a number here covers every future send.
 *
 * With `applyToCampaignId`, adding also splices the number straight into that
 * one already-created draft's CSV — a draft's audience is built once at
 * creation and never rebuilt, so without this an addition would only take
 * effect from the *next* campaign onwards.
 */
export default function TestNumbersPanel({
  applyToCampaignId,
  onApplied,
}: {
  applyToCampaignId?: string;
  onApplied?: () => void;
}) {
  const [testNumbers, setTestNumbers] = useState<TestNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    apiRequest<{ testNumbers: TestNumber[] }>("/workshops/test-numbers")
      .then((d) => setTestNumbers(d.testNumbers))
      .catch(() => setNote("Couldn't load test numbers"))
      .finally(() => setLoading(false));
  }, []);

  const add = async () => {
    if (!name.trim() || !phone.trim()) return;
    setAdding(true);
    setNote("");
    try {
      const d = await apiRequest<{ testNumbers: TestNumber[] }>("/workshops/test-numbers", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
      });
      setTestNumbers(d.testNumbers);

      if (applyToCampaignId) {
        await apiRequest(`/campaigns/${applyToCampaignId}/add-test-number`, {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
        });
        onApplied?.();
        setNote("Added, and included in this campaign");
      } else {
        setNote("Added — included in every future send");
      }
      setName("");
      setPhone("");
      setShowForm(false);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (target: string) => {
    try {
      const d = await apiRequest<{ testNumbers: TestNumber[] }>("/workshops/test-numbers", {
        method: "DELETE",
        body: JSON.stringify({ phone: target }),
      });
      setTestNumbers(d.testNumbers);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed to remove");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-gray-500" />
          <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            Test numbers
          </span>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : testNumbers.length === 0 ? (
        <p className="text-xs text-gray-500">
          None yet — added numbers receive every campaign alongside real contacts.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {testNumbers.map((n) => (
            <span
              key={n.phone}
              className="inline-flex items-center gap-1.5 bg-white border border-gray-200 rounded-full pl-2.5 pr-1.5 py-1 text-xs text-gray-700"
            >
              {n.name} · {n.phone}
              <button
                onClick={() => remove(n.phone)}
                className="text-gray-400 hover:text-red-600"
                aria-label={`Remove ${n.name}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {showForm && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="flex-1 min-w-[110px] border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="919029309137"
            className="flex-1 min-w-[130px] border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs"
          />
          <button
            onClick={add}
            disabled={adding || !name.trim() || !phone.trim()}
            className="bg-gray-900 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      )}

      {note && <p className="mt-2 text-xs text-gray-500">{note}</p>}
    </div>
  );
}
