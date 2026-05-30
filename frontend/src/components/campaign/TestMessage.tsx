"use client";

import { useState } from "react";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { apiRequest } from "@/lib/api";
import { Send, CheckCircle, XCircle } from "lucide-react";

interface Props {
  draft: CampaignDraft;
  onNext: () => void;
  onBack: () => void;
}

interface TestResult {
  phoneNumberId: string;
  displayName: string;
  status: string;
  error?: string;
  messageId?: string;
}

export default function TestMessage({ draft, onNext, onBack }: Props) {
  const [testPhone, setTestPhone] = useState("");
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => {
    // Pre-fill with static values from parameterMapping
    const values: Record<string, string> = {};
    Object.entries(draft.parameterMapping).forEach(([key, val]) => {
      if (val.startsWith("__STATIC__")) {
        values[key] = val.replace("__STATIC__", "");
      } else {
        values[key] = ""; // CSV columns need manual input for test
      }
    });
    return values;
  });
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const [sent, setSent] = useState(false);

  const paramCount = draft.template?.parameterCount || 0;
  const params = Array.from({ length: paramCount }, (_, i) => String(i + 1));

  const updateParam = (key: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleTestSend = async () => {
    setSending(true);
    setResults([]);
    try {
      const data = await apiRequest<{ results: TestResult[] }>("/campaigns/test-send", {
        method: "POST",
        body: JSON.stringify({
          businessId: draft.business!.businessId,
          selectedNumbers: draft.selectedNumbers,
          templateName: draft.template!.templateName,
          templateMappings: draft.templateMappings,
          parameterValues: paramValues,
          headerImageUrl: draft.headerImageUrl || undefined,
          testPhone,
        }),
      });
      setResults(data.results);
      setSent(true);
    } catch (err) {
      console.error("Test send failed:", err);
      setResults([{
        phoneNumberId: "",
        displayName: "All",
        status: "failed",
        error: err instanceof Error ? err.message : "Test send failed",
      }]);
    } finally {
      setSending(false);
    }
  };

  const allParamsFilled = params.every((p) => paramValues[p]?.trim());
  const phoneValid = /^\d{10,15}$/.test(testPhone.replace(/\D/g, ""));

  // Get label for parameter
  const getParamLabel = (key: string) => {
    const mapping = draft.parameterMapping[key];
    if (!mapping) return `Parameter {{${key}}}`;
    if (mapping.startsWith("__STATIC__")) return `{{${key}}} (static)`;
    return `{{${key}}} → CSV: ${mapping}`;
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">Test Message</h3>
      <p className="text-sm text-gray-500 mb-2">
        Send a test message from all {draft.selectedNumbers.length} numbers to verify everything works.
      </p>
      <div className="mb-5 p-3 bg-gray-50 rounded-lg text-sm">
        <span className="text-gray-500">Template:</span>{" "}
        <span className="font-medium text-gray-900">{draft.template?.templateName}</span>
        <span className="text-gray-400 ml-2">• {draft.template?.parameterCount} params</span>
        {draft.headerImageUrl && <span className="text-gray-400 ml-2">• has image header</span>}
      </div>

      {/* Test Phone Number */}
      <div className="mb-5">
        <label className="block text-sm font-medium text-gray-700 mb-1">Test Phone Number</label>
        <input
          type="text"
          value={testPhone}
          onChange={(e) => setTestPhone(e.target.value.replace(/\D/g, ""))}
          placeholder="919999999999 (with country code, no +)"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {/* Parameter Values */}
      <div className="mb-5">
        <label className="block text-sm font-medium text-gray-700 mb-2">Parameter Values for Test</label>
        <div className="space-y-3">
          {params.map((key) => (
            <div key={key} className="flex items-center gap-3">
              <span className="text-xs text-gray-500 w-36 truncate">{getParamLabel(key)}</span>
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

      {/* Send Test Button */}
      <button
        onClick={handleTestSend}
        disabled={!phoneValid || !allParamsFilled || sending}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
      >
        <Send className="w-4 h-4" />
        {sending ? "Sending..." : `Send Test to ${testPhone || "..."}`}
      </button>

      {/* Results */}
      {results.length > 0 && (
        <div className="mt-5 space-y-2">
          <p className="text-sm font-medium text-gray-700">Results:</p>
          {results.map((r, i) => {
            const number = draft.selectedNumbers.find((n) => n.phoneNumberId === r.phoneNumberId);
            return (
              <div
                key={i}
                className={`p-3 rounded-lg text-sm ${
                  r.status === "sent" ? "bg-green-50" : "bg-red-50"
                }`}
              >
                <div className="flex items-center gap-2">
                  {r.status === "sent" ? (
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-600" />
                  )}
                  <span className="font-medium text-gray-900">{r.displayName}</span>
                  <span className="text-gray-400">•</span>
                  <span className="text-xs text-gray-500">{number?.displayNumber}</span>
                </div>
                <div className="ml-6 mt-1">
                  {r.status === "sent" ? (
                    <p className="text-xs text-green-700">
                      Accepted by Meta • ID: {r.messageId?.slice(0, 20)}...
                    </p>
                  ) : (
                    <p className="text-xs text-red-700">{r.error}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={onNext}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          {sent ? "Continue to Schedule" : "Skip Test & Continue"}
        </button>
      </div>
    </div>
  );
}
