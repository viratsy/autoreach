"use client";

import { CampaignDraft } from "@/app/campaigns/new/page";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function MapParameters({ draft, onUpdate, onNext, onBack }: Props) {
  const paramCount = draft.template?.parameterCount || 0;
  const params = Array.from({ length: paramCount }, (_, i) => String(i + 1));

  const handleMap = (paramIndex: string, csvHeader: string) => {
    onUpdate({
      parameterMapping: { ...draft.parameterMapping, [paramIndex]: csvHeader },
    });
  };

  // Auto-match common patterns
  const autoMatch = () => {
    const mapping: Record<string, string> = {};
    const headerLower = draft.csvHeaders.map((h) => h.toLowerCase());

    params.forEach((p, i) => {
      // Simple heuristic: match by position if names don't match
      if (headerLower[i] && headerLower[i] !== "phone") {
        mapping[p] = draft.csvHeaders[i];
      }
    });
    onUpdate({ parameterMapping: mapping });
  };

  const allMapped = params.every((p) => draft.parameterMapping[p]);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Map Parameters</h3>
        <button onClick={autoMatch} className="text-sm text-primary-600 hover:text-primary-700">
          Auto-match
        </button>
      </div>

      {draft.template && (
        <div className="mb-4 p-3 bg-gray-50 rounded-lg">
          <p className="text-xs text-gray-500 mb-1">Template preview:</p>
          <p className="text-sm text-gray-700">
            {draft.template.components[0]?.text || "No body text"}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {params.map((paramIndex) => (
          <div key={paramIndex} className="flex items-center gap-4">
            <span className="text-sm text-gray-600 w-32">
              Parameter {"{{"}{paramIndex}{"}}"}
            </span>
            <span className="text-gray-400">→</span>
            <select
              value={draft.parameterMapping[paramIndex] || ""}
              onChange={(e) => handleMap(paramIndex, e.target.value)}
              className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2"
            >
              <option value="">Select CSV column</option>
              {draft.csvHeaders
                .filter((h) => h !== "phone")
                .map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
            </select>
          </div>
        ))}
      </div>

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!allMapped}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
