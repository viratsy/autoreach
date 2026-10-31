"use client";

import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api";
import { Mail, Send, AlertTriangle, CheckCircle2, Search, X } from "lucide-react";

interface EmailTemplate {
  templateId: string;
  name: string;
  subject: string;
  params: string[];
  runKeys?: string[];
  enabled: boolean;
}

interface TestResult {
  sentTo: string;
  templateLabel: string;
  templateEnabled: boolean;
  subject: string;
  usedContact: string;
  missingParams: string[];
}

/** Matches the backend's normalizeRunKey — "WE ARE LIVE" → "we_are_live". */
const normalizeRunKey = (msg: string) => (msg || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Picks the email a campaign sends, from the standalone template library.
 *
 * Email is opt-in twice over: a template has to be chosen AND the toggle turned
 * on, so adding copy to the library can never retroactively start emailing
 * campaigns that were already scheduled.
 */
export default function EmailChannelPanel({
  msg,
  enabled,
  onChange,
  templateId,
  onTemplateChange,
  campaignId,
  csvS3Key,
  contactCount,
}: {
  msg: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  templateId?: string;
  onTemplateChange: (templateId: string) => void;
  campaignId?: string;
  /** The uploaded CSV, so a test can render from a real contact before the
   *  campaign exists. Without it the send has no values to substitute. */
  csvS3Key?: string;
  contactCount: number;
}) {
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest<{ templates: EmailTemplate[] }>("/email-templates")
      .then((d) => setTemplates(d.templates))
      .catch(() => setTemplates([]));
  }, []);

  const loading = templates === null;
  const template = templates?.find((t) => t.templateId === templateId) || null;

  // Convenience only, never an automatic send: for the run keys the nightly
  // scheduler produces, the matching template is offered pre-selected so the
  // common case stays one click. The toggle is still off until switched on.
  const suggested = useMemo(() => {
    if (!templates || templateId) return null;
    const key = normalizeRunKey(msg);
    if (!key) return null;
    return templates.find((t) => (t.runKeys || []).includes(key)) || null;
  }, [templates, templateId, msg]);

  useEffect(() => {
    if (suggested) onTemplateChange(suggested.templateId);
    // onTemplateChange is a fresh closure each render in the parent; depending
    // on it here would re-fire this every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested]);

  const filtered = useMemo(() => {
    const list = templates || [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((t) => `${t.name} ${t.subject}`.toLowerCase().includes(q));
  }, [templates, query]);

  const pick = (t: EmailTemplate) => {
    onTemplateChange(t.templateId);
    setPicking(false);
    setQuery("");
    setResult(null);
  };

  // A test needs somewhere to read values from: either a saved campaign or an
  // uploaded CSV. Everything else about the panel works without both.
  const canTest = Boolean(campaignId || csvS3Key);

  const clear = () => {
    onTemplateChange("");
    onChange(false);
    setResult(null);
  };

  const sendTest = async () => {
    if (!canTest || !testEmail.trim()) return;
    setSending(true);
    setError("");
    setResult(null);
    try {
      // Two shapes of the same endpoint: an existing campaign renders from its
      // own stored CSV, a draft sends the template and CSV key along with the
      // request because there is no campaign to read them from yet.
      const d = await apiRequest<TestResult>(
        campaignId ? `/campaigns/${campaignId}/test-email` : "/campaigns/test-email",
        {
          method: "POST",
          body: JSON.stringify({
            email: testEmail.trim(),
            templateId: templateId || undefined,
            csvS3Key: campaignId ? undefined : csvS3Key,
          }),
        }
      );
      setResult(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send test email");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mb-6 border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex items-start justify-between gap-4 px-4 py-3 bg-gray-50">
        <div className="flex items-start gap-3 min-w-0">
          <Mail className="w-5 h-5 text-gray-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Also send by email</p>
            <p className="text-xs text-gray-500 mt-0.5 truncate">
              {loading
                ? "Loading templates…"
                : template
                  ? template.name
                  : "No email template chosen"}
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!template}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 accent-primary-600 disabled:opacity-40"
          />
          <span className={`text-sm ${template ? "text-gray-700" : "text-gray-400"}`}>
            {enabled ? "On" : "Off"}
          </span>
        </label>
      </div>

      <div className="px-4 py-3 border-t border-gray-100 space-y-3">
        {/* Picker */}
        {picking || !template ? (
          <div className="space-y-2">
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search email templates…"
                className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm"
              />
            </div>
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-56 overflow-y-auto">
              {filtered.map((t) => (
                <button
                  key={t.templateId}
                  onClick={() => pick(t)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-900 truncate">{t.name}</span>
                    {!t.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 shrink-0">
                        off
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate">{t.subject}</p>
                </button>
              ))}
              {!loading && filtered.length === 0 && (
                <p className="px-3 py-4 text-xs text-gray-500">
                  {(templates || []).length === 0
                    ? "No email templates yet — create one under Email templates."
                    : "Nothing matches that search."}
                </p>
              )}
            </div>
            {picking && template && (
              <button
                onClick={() => setPicking(false)}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-gray-600 min-w-0">
              <span className="text-gray-400">Subject:</span> {template.subject}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setPicking(true)}
                className="text-xs text-primary-600 hover:text-primary-700"
              >
                Change
              </button>
              <button
                onClick={clear}
                title="Remove email from this campaign"
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {template && enabled && (
          <p className="text-xs text-gray-600">
            Goes to the same {contactCount.toLocaleString()} contacts at the same scheduled time.
            Contacts with no email address, an unsubscribe, or a past hard bounce are skipped
            automatically.
          </p>
        )}

        {/* A template can be chosen but switched off in the library — worth
            saying, since the toggle would otherwise look like it's enough. */}
        {template && enabled && !template.enabled && (
          <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-900">
              This template is switched off in the library, so nothing will actually send. Test
              emails still work — that&apos;s what the switch is for.
            </p>
          </div>
        )}

        {template &&
          (canTest ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="you@example.com"
                className="flex-1 min-w-[180px] border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
              />
              <button
                onClick={sendTest}
                disabled={sending || !testEmail.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-gray-900 text-white rounded-lg disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {sending ? "Sending…" : "Send test email"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-400">
              Upload the CSV first — the test renders using a real contact from it.
            </p>
          ))}

        {error && <p className="text-xs text-red-600">{error}</p>}

        {result && (
          <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 space-y-1">
            <p className="text-xs text-green-900 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> Sent to {result.sentTo}
            </p>
            <p className="text-xs text-green-800">
              Rendered from {result.usedContact} — subject “{result.subject}”
            </p>
            {result.missingParams.length > 0 && (
              <p className="text-xs text-amber-800">
                Missing for this contact: {result.missingParams.join(", ")} — the real send skips
                anyone without these rather than mailing a broken link.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
