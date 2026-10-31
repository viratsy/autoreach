"use client";

import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import { apiRequest } from "@/lib/api";
import ConfirmDialog, { ConfirmDialogState } from "@/components/shared/ConfirmDialog";
import { Mail, Plus, Trash2, AlertTriangle, CheckCircle2, Search } from "lucide-react";

interface EmailTemplate {
  templateId: string;
  name: string;
  subject: string;
  body: string;
  params: string[];
  /** Legacy run-key matching, kept for campaigns created before the picker. */
  runKeys?: string[];
  enabled: boolean;
  updatedAt?: string;
}

/**
 * Columns the campaign CSV always carries, so a placeholder using one of these
 * is guaranteed to resolve. Anything else is flagged while editing rather than
 * discovered when a send skips every contact for a missing value.
 */
const KNOWN_PARAMS = [
  "name",
  "email",
  "phone",
  "workshop_name",
  "full_workshop_name",
  "workshop_date",
  "workshop_time",
  "workshop_date_time",
  "zoom_link",
  "whatsapp_group",
  "mentor_name",
];

const blank = (): EmailTemplate => ({
  templateId: "",
  name: "",
  subject: "",
  body: "",
  params: [],
  runKeys: [],
  enabled: false,
  updatedAt: undefined,
});

const findParams = (text: string) => [...new Set([...text.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]))];

/**
 * The email template library — standalone copy, named and searched on its own
 * terms rather than tied to a WhatsApp run key. A campaign picks one while
 * being set up; nothing here sends by itself.
 */
export default function EmailTemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<EmailTemplate>(blank());
  const [isNew, setIsNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const load = () =>
    apiRequest<{ templates: EmailTemplate[] }>("/email-templates").then((d) => {
      setTemplates(d.templates);
      return d.templates;
    });

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load templates"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 2500);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const open = (tpl: EmailTemplate) => {
    setSelected(tpl.templateId);
    setDraft({ ...tpl });
    setIsNew(false);
    setError("");
  };

  const startNew = () => {
    setSelected(null);
    setDraft(blank());
    setIsNew(true);
    setError("");
  };

  const detected = useMemo(() => findParams(`${draft.subject}\n${draft.body}`), [draft.subject, draft.body]);
  const unknown = detected.filter((p) => !KNOWN_PARAMS.includes(p));

  // Search covers the subject and body too, not just the name — picking the
  // right template is usually "the one that mentions the zoom link".
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) =>
      [t.name, t.subject, t.body, ...(t.runKeys || [])].join(" ").toLowerCase().includes(q)
    );
  }, [templates, query]);

  const save = async () => {
    if (!draft.name.trim() || !draft.subject.trim() || !draft.body.trim()) {
      setError("Name, subject and body are all required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const d = await apiRequest<{ template: EmailTemplate }>("/email-templates", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      await load();
      // Creating mints the id server-side, so re-open on what came back rather
      // than on the draft — otherwise a new template stays "unsaved" on screen
      // and saving again would create a second copy.
      open(d.template);
      setToast("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const remove = (tpl: EmailTemplate) =>
    setConfirmState({
      title: "Delete email template",
      message: `Delete "${tpl.name}"? Campaigns already set to send it will go back to WhatsApp only.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        await apiRequest("/email-templates", {
          method: "DELETE",
          body: JSON.stringify({ templateId: tpl.templateId }),
        });
        await load();
        if (selected === tpl.templateId) startNew();
        setToast("Deleted");
      },
    });

  const enabledCount = templates.filter((t) => t.enabled).length;

  return (
    <AuthGuard>
      <AppShell>
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Email templates</h1>
            <p className="text-sm text-gray-600 mt-1 max-w-3xl">
              A library of email copy you can reuse. Campaigns pick one by name while being set up —
              a template here never sends on its own.
            </p>
          </div>
          <button
            onClick={startNew}
            className="flex items-center gap-2 bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800"
          >
            <Plus className="w-4 h-4" /> New template
          </button>
        </div>

        {enabledCount === 0 && templates.length > 0 && (
          <div className="mb-4 flex gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-900">
              All {templates.length} templates are switched off, so no campaign will email anyone.
              Test one first, then enable it here.
            </p>
          </div>
        )}

        {toast && (
          <div className="mb-4 flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-sm text-green-800">
            <CheckCircle2 className="w-4 h-4" /> {toast}
          </div>
        )}

        {loading ? (
          <p className="text-gray-500">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="p-3 border-b border-gray-200">
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search templates…"
                    className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  {filtered.length} of {templates.length} · {enabledCount} on
                </p>
              </div>
              <div className="divide-y divide-gray-100 max-h-[32rem] overflow-y-auto">
                {filtered.map((tpl) => (
                  <button
                    key={tpl.templateId}
                    onClick={() => open(tpl)}
                    className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 ${
                      selected === tpl.templateId ? "bg-primary-50" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">{tpl.name}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                          tpl.enabled ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {tpl.enabled ? "on" : "off"}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 truncate mt-0.5">{tpl.subject}</p>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-4 py-6 text-sm text-gray-500">
                    {templates.length === 0 ? "No templates yet." : "Nothing matches that search."}
                  </p>
                )}
              </div>
            </div>

            <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-5">
              {!isNew && !selected ? (
                <div className="text-center py-12">
                  <Mail className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">Pick a template to edit, or create a new one.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="e.g. 1 Day To Go"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      This is what you&apos;ll search for when picking an email for a campaign.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
                    <input
                      value={draft.subject}
                      onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Body</label>
                    <textarea
                      value={draft.body}
                      onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                      rows={14}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      Use {"{{name}}"}, {"{{zoom_link}}"} etc. Values come from the campaign&apos;s own
                      CSV, so the date and links match the WhatsApp message exactly.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {detected.map((p) => (
                      <span
                        key={p}
                        className={`text-[11px] px-2 py-0.5 rounded-full ${
                          KNOWN_PARAMS.includes(p)
                            ? "bg-gray-100 text-gray-600"
                            : "bg-amber-50 text-amber-800 border border-amber-200"
                        }`}
                      >
                        {`{{${p}}}`}
                      </span>
                    ))}
                    {detected.length === 0 && (
                      <span className="text-xs text-gray-400">No placeholders used.</span>
                    )}
                  </div>

                  {unknown.length > 0 && (
                    <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-900">
                        {unknown.map((u) => `{{${u}}}`).join(", ")} {unknown.length === 1 ? "is" : "are"}{" "}
                        not a column the campaign CSV carries. Any contact without a value for it is
                        skipped rather than emailed a broken message — so this template may send to
                        nobody.
                      </p>
                    </div>
                  )}

                  {/* Campaigns created before the picker resolve their email by
                      run key instead of by id. Shown read-only so it's clear why
                      an older campaign still emails, and so deleting the template
                      isn't done blind. */}
                  {(draft.runKeys?.length || 0) > 0 && (
                    <div className="border border-gray-200 rounded-lg px-3 py-2">
                      <p className="text-xs text-gray-500">
                        Also used automatically by older campaigns whose message is{" "}
                        {draft.runKeys!.map((rk) => (
                          <span key={rk} className="font-mono text-gray-700">
                            {rk}{" "}
                          </span>
                        ))}
                      </p>
                    </div>
                  )}

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                      className="w-4 h-4 accent-primary-600"
                    />
                    <span className="text-sm text-gray-700">
                      Enabled — campaigns may send this email
                    </span>
                  </label>

                  {error && <p className="text-sm text-red-600">{error}</p>}

                  <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                    <button
                      onClick={save}
                      disabled={saving}
                      className="bg-primary-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    {!isNew && selected && (
                      <button
                        onClick={() => remove(draft)}
                        className="flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="w-4 h-4" /> Delete
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <ConfirmDialog
          state={confirmState}
          loading={confirmLoading}
          onCancel={() => setConfirmState(null)}
          onConfirm={async () => {
            if (!confirmState) return;
            setConfirmLoading(true);
            try {
              await confirmState.onConfirm();
            } finally {
              setConfirmLoading(false);
              setConfirmState(null);
            }
          }}
        />
      </AppShell>
    </AuthGuard>
  );
}
