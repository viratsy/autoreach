"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import ImagePicker from "@/components/campaign/ImagePicker";
import TemplatePreview from "@/components/campaign/TemplatePreview";
import { apiRequest } from "@/lib/api";
import { Business, TemplateComponent } from "@/types";
import { Send, CheckCircle, XCircle, RefreshCw } from "lucide-react";

interface TemplateInfo {
  templateName: string;
  category: string;
  parameterCount: number;
  components: TemplateComponent[];
  availableOn: string[];
  hasImageHeaderPerNumber?: Record<string, boolean>;
}

interface SendResult {
  phoneNumberId: string;
  displayName: string;
  status: string;
  error?: string;
  messageId?: string;
}

export default function QuickSendPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [syncingTemplates, setSyncingTemplates] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [headerImageUrl, setHeaderImageUrl] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  const business = businesses.find((b) => b.businessId === businessId);
  const number = business?.phoneNumbers.find((pn) => pn.phoneNumberId === phoneNumberId);
  const template = templates.find((t) => t.templateName === templateName);
  const paramKeys = Array.from({ length: template?.parameterCount || 0 }, (_, i) => String(i + 1));
  const needsHeaderImage = Boolean(template?.hasImageHeaderPerNumber?.[phoneNumberId]);

  useEffect(() => {
    apiRequest<{ businesses: Business[] }>("/businesses").then((data) => {
      setBusinesses(data.businesses);
      if (data.businesses.length > 0) setBusinessId(data.businesses[0].businessId);
    });
  }, []);

  useEffect(() => {
    if (!business || business.phoneNumbers.length === 0) {
      setPhoneNumberId("");
      return;
    }
    setPhoneNumberId(business.phoneNumbers[0].phoneNumberId);
  }, [businessId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTemplates = () => {
    if (!businessId) return;
    setLoadingTemplates(true);
    apiRequest<{ templates: TemplateInfo[] }>(`/templates?businessId=${businessId}`)
      .then((data) => setTemplates(data.templates))
      .catch(() => setTemplates([]))
      .finally(() => setLoadingTemplates(false));
  };

  useEffect(() => {
    setTemplateName("");
    setResult(null);
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  // A number added to a business after the last full sync has zero rows in
  // our own DB even though real approved templates exist on Meta's side —
  // this page had no way to fix that short of navigating to /templates, so
  // "no templates" here often meant "never synced," not "genuinely none."
  const syncTemplates = async () => {
    if (!businessId) return;
    setSyncingTemplates(true);
    try {
      await apiRequest("/templates/fetch", { method: "POST", body: JSON.stringify({ businessId }) });
      loadTemplates();
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncingTemplates(false);
    }
  };

  useEffect(() => {
    setParamValues({});
    setHeaderImageUrl("");
    setResult(null);
  }, [templateName, phoneNumberId]);

  const availableTemplates = templates.filter((t) => t.availableOn.includes(phoneNumberId));

  const updateParam = (key: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [key]: value }));
  };

  const phoneValid = /^\d{10,15}$/.test(recipient.replace(/\D/g, ""));
  const allParamsFilled = paramKeys.every((k) => paramValues[k]?.trim());
  const canSend = phoneValid && allParamsFilled && (!needsHeaderImage || headerImageUrl) && template && number && !sending;

  const handleSend = async () => {
    if (!business || !number || !template) return;
    setSending(true);
    setResult(null);
    try {
      const data = await apiRequest<{ results: SendResult[] }>("/campaigns/test-send", {
        method: "POST",
        body: JSON.stringify({
          businessId: business.businessId,
          selectedNumbers: [number],
          templateName: template.templateName,
          templateMappings: {},
          parameterValues: paramValues,
          headerImageUrl: needsHeaderImage ? headerImageUrl : undefined,
          numbersWithImageHeader: needsHeaderImage ? [phoneNumberId] : [],
          testPhone: recipient.replace(/\D/g, ""),
        }),
      });
      setResult(data.results[0]);
    } catch (err) {
      setResult({ phoneNumberId, displayName: number.displayName, status: "failed", error: err instanceof Error ? err.message : "Send failed" });
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthGuard>
      <AppShell>
          <div className="max-w-4xl">
            <h2 className="text-2xl font-bold text-gray-900 mb-1">Quick Send</h2>
            <p className="text-sm text-gray-500 mb-6">Send a single one-off template message — no campaign needed.</p>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Business</label>
                  <select
                    value={businessId}
                    onChange={(e) => setBusinessId(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    {businesses.map((b) => (
                      <option key={b.businessId} value={b.businessId}>{b.businessName}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Sending Number</label>
                  <select
                    value={phoneNumberId}
                    onChange={(e) => setPhoneNumberId(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    {business?.phoneNumbers.map((pn) => (
                      <option key={pn.phoneNumberId} value={pn.phoneNumberId}>
                        {pn.displayName} ({pn.displayNumber})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-gray-600">Template</label>
                  <button
                    type="button"
                    onClick={syncTemplates}
                    disabled={syncingTemplates || !businessId}
                    className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${syncingTemplates ? "animate-spin" : ""}`} /> {syncingTemplates ? "Syncing..." : "Sync Templates"}
                  </button>
                </div>
                <select
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  disabled={loadingTemplates}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50"
                >
                  <option value="">
                    {loadingTemplates ? "Loading templates..." : "Select a template"}
                  </option>
                  {availableTemplates.map((t) => (
                    <option key={t.templateName} value={t.templateName}>
                      {t.templateName} ({t.parameterCount} params, {t.category})
                    </option>
                  ))}
                </select>
                {!loadingTemplates && phoneNumberId && availableTemplates.length === 0 && (
                  <p className="text-xs text-gray-400 mt-1">No templates available on this number yet.</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Recipient Phone</label>
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.replace(/\D/g, ""))}
                  placeholder="919999999999 (with country code, no +)"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>

              {paramKeys.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">Parameter Values</label>
                  <div className="space-y-2">
                    {paramKeys.map((key) => (
                      <div key={key} className="flex items-center gap-3">
                        <span className="text-xs text-gray-500 w-16">{`{{${key}}}`}</span>
                        <input
                          type="text"
                          value={paramValues[key] || ""}
                          onChange={(e) => updateParam(key, e.target.value)}
                          placeholder={`Value for {{${key}}}`}
                          className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {needsHeaderImage && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Header Image (required)</label>
                  <ImagePicker value={headerImageUrl} onChange={setHeaderImageUrl} />
                </div>
              )}

              <button
                onClick={handleSend}
                disabled={!canSend}
                className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-primary-700 transition-colors"
              >
                <Send className="w-4 h-4" />
                {sending ? "Sending..." : "Send"}
              </button>

              {result && (
                <div className={`p-3 rounded-lg text-sm flex items-start gap-2 ${result.status === "sent" ? "bg-green-50" : "bg-red-50"}`}>
                  {result.status === "sent" ? (
                    <CheckCircle className="w-4 h-4 text-green-600 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-600 mt-0.5" />
                  )}
                  <div>
                    <p className="font-medium text-gray-900">{result.status === "sent" ? "Sent" : "Failed"}</p>
                    {result.status === "sent" ? (
                      <p className="text-xs text-green-700">{result.messageId ? `ID: ${result.messageId}` : "Accepted"}</p>
                    ) : (
                      <p className="text-xs text-red-700">{result.error}</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="lg:sticky lg:top-4 lg:self-start">
              <TemplatePreview
                template={template ? { components: template.components } : null}
                resolvedValues={paramValues}
                headerImageUrl={needsHeaderImage ? headerImageUrl : undefined}
              />
            </div>
            </div>
          </div>
      </AppShell>
    </AuthGuard>
  );
}
