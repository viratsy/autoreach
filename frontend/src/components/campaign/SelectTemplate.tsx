"use client";

import { useState } from "react";
import { Template } from "@/types";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { AlertTriangle } from "lucide-react";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

// Mock templates — replace with API fetch
const mockTemplates: Template[] = [
  {
    templateName: "adv_confirmation",
    language: "en",
    category: "MARKETING",
    components: [{ type: "BODY", text: "Hello {{1}}, your workshop on {{2}}. Join: {{3}}" }],
    parameterCount: 3,
    status: "approved",
    lastSyncedAt: "",
  },
  {
    templateName: "emi_reminder",
    language: "en",
    category: "UTILITY",
    components: [{ type: "BODY", text: "Hi {{1}}, your EMI of {{2}} is due on {{3}}" }],
    parameterCount: 3,
    status: "approved",
    lastSyncedAt: "",
  },
];

export default function SelectTemplate({ draft, onUpdate, onNext, onBack }: Props) {
  const [mismatchNumbers, setMismatchNumbers] = useState<string[]>([]);
  const [showMappingUI, setShowMappingUI] = useState(false);

  const handleSelect = (template: Template) => {
    // Check if template exists on all selected numbers
    // In real implementation, query Templates table for each number
    // For now, simulate a mismatch on the third number
    const mismatches = draft.selectedNumbers
      .filter((_, i) => i === 2 && template.templateName === "adv_confirmation")
      .map((n) => n.phoneNumberId);

    setMismatchNumbers(mismatches);
    onUpdate({ template, templateMappings: {} });

    if (mismatches.length > 0) {
      setShowMappingUI(true);
    }
  };

  const handleMapping = (phoneNumberId: string, altTemplateName: string) => {
    onUpdate({
      templateMappings: { ...draft.templateMappings, [phoneNumberId]: altTemplateName },
    });
  };

  const canProceed =
    draft.template && mismatchNumbers.every((id) => draft.templateMappings[id]);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Select Template</h3>

      <div className="space-y-2">
        {mockTemplates.map((tpl) => (
          <button
            key={tpl.templateName}
            onClick={() => handleSelect(tpl)}
            className={`w-full text-left p-4 rounded-lg border transition-colors ${
              draft.template?.templateName === tpl.templateName
                ? "border-primary-500 bg-primary-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <div className="flex items-center justify-between">
              <p className="font-medium text-gray-900 text-sm">{tpl.templateName}</p>
              <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded">
                {tpl.category}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1">{tpl.parameterCount} parameters</p>
          </button>
        ))}
      </div>

      {showMappingUI && mismatchNumbers.length > 0 && (
        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600" />
            <p className="text-sm font-medium text-yellow-700">Template mismatch detected</p>
          </div>
          <p className="text-xs text-yellow-600 mb-3">
            The selected template is not available on all numbers. Map an alternative:
          </p>
          {mismatchNumbers.map((phoneId) => {
            const number = draft.selectedNumbers.find((n) => n.phoneNumberId === phoneId);
            return (
              <div key={phoneId} className="flex items-center gap-3 mt-2">
                <span className="text-xs text-gray-700">{number?.displayName}:</span>
                <input
                  type="text"
                  placeholder="Alternative template name"
                  value={draft.templateMappings[phoneId] || ""}
                  onChange={(e) => handleMapping(phoneId, e.target.value)}
                  className="flex-1 text-sm border border-gray-300 rounded px-3 py-1.5"
                />
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
          disabled={!canProceed}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
