"use client";

import { useState } from "react";
import { CampaignDraft } from "@/app/campaigns/new/page";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

type MappingSource = "csv" | "manual";

interface ParamConfig {
  source: MappingSource;
  csvColumn: string;
  manualValue: string;
}

export default function MapParameters({ draft, onUpdate, onNext, onBack }: Props) {
  const paramCount = draft.template?.parameterCount || 0;
  const params = Array.from({ length: paramCount }, (_, i) => String(i + 1));

  // Get template body text
  const bodyComponent = draft.template?.components?.find(
    (c) => (c.type as string).toUpperCase() === "BODY"
  );
  const templateBody = (bodyComponent as unknown as { text?: string })?.text || "";

  // Track source type per parameter
  const [paramConfigs, setParamConfigs] = useState<Record<string, ParamConfig>>(() => {
    const initial: Record<string, ParamConfig> = {};
    params.forEach((p) => {
      initial[p] = {
        source: "csv",
        csvColumn: draft.parameterMapping[p] || "",
        manualValue: "",
      };
    });
    return initial;
  });

  const updateParam = (paramIndex: string, updates: Partial<ParamConfig>) => {
    const newConfigs = { ...paramConfigs, [paramIndex]: { ...paramConfigs[paramIndex], ...updates } };
    setParamConfigs(newConfigs);

    // Update the draft parameterMapping
    const mapping: Record<string, string> = {};
    Object.entries(newConfigs).forEach(([key, config]) => {
      if (config.source === "csv" && config.csvColumn) {
        mapping[key] = config.csvColumn;
      } else if (config.source === "manual" && config.manualValue) {
        mapping[key] = `__STATIC__${config.manualValue}`;
      }
    });
    onUpdate({ parameterMapping: mapping });
  };

  // Auto-match CSV headers to parameters
  const autoMatch = () => {
    const newConfigs = { ...paramConfigs };
    const csvHeaders = draft.csvHeaders.filter((h) => h !== "phone");
    params.forEach((p, i) => {
      if (csvHeaders[i]) {
        newConfigs[p] = { source: "csv", csvColumn: csvHeaders[i], manualValue: "" };
      }
    });
    setParamConfigs(newConfigs);

    const mapping: Record<string, string> = {};
    Object.entries(newConfigs).forEach(([key, config]) => {
      if (config.csvColumn) mapping[key] = config.csvColumn;
    });
    onUpdate({ parameterMapping: mapping });
  };

  // Generate preview with filled values
  const getPreview = () => {
    let preview = templateBody;
    params.forEach((p) => {
      const config = paramConfigs[p];
      let value = "___";
      if (config.source === "csv" && config.csvColumn) {
        value = `[${config.csvColumn}]`;
      } else if (config.source === "manual" && config.manualValue) {
        value = config.manualValue;
      }
      preview = preview.replace(`{{${p}}}`, value);
    });
    return preview;
  };

  const allMapped = params.every((p) => {
    const config = paramConfigs[p];
    return (config.source === "csv" && config.csvColumn) ||
           (config.source === "manual" && config.manualValue);
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Map Parameters</h3>
        <button onClick={autoMatch} className="text-sm text-primary-600 hover:text-primary-700">
          Auto-match
        </button>
      </div>

      {/* Template Body Preview */}
      {templateBody && (
        <div className="mb-5 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <p className="text-xs text-gray-500 mb-1 font-medium">
            Template: <span className="text-gray-900">{draft.template?.templateName}</span>
            <span className="ml-2 text-gray-400">({paramCount} body parameters)</span>
          </p>
          <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed mt-2">{templateBody}</p>
        </div>
      )}

      {/* Header Image URL (if template has image header) */}
      <div className="mb-5">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Header Image URL <span className="text-gray-400 font-normal">(if template has image header)</span>
        </label>
        <input
          type="text"
          value={draft.headerImageUrl || ""}
          onChange={(e) => onUpdate({ headerImageUrl: e.target.value })}
          placeholder="https://example.com/image.jpg (leave empty if no image header)"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {/* Parameter Mapping */}
      <div className="space-y-4">
        {params.map((paramIndex) => {
          const config = paramConfigs[paramIndex];
          return (
            <div key={paramIndex} className="border border-gray-100 rounded-lg p-3">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-sm font-medium text-gray-700 w-24">
                  {`{{${paramIndex}}}`}
                </span>
                {/* Source toggle */}
                <div className="flex bg-gray-100 rounded-md p-0.5">
                  <button
                    onClick={() => updateParam(paramIndex, { source: "csv" })}
                    className={`px-3 py-1 text-xs rounded ${
                      config.source === "csv"
                        ? "bg-white text-gray-900 shadow-sm font-medium"
                        : "text-gray-500"
                    }`}
                  >
                    From CSV
                  </button>
                  <button
                    onClick={() => updateParam(paramIndex, { source: "manual" })}
                    className={`px-3 py-1 text-xs rounded ${
                      config.source === "manual"
                        ? "bg-white text-gray-900 shadow-sm font-medium"
                        : "text-gray-500"
                    }`}
                  >
                    Static Value
                  </button>
                </div>
              </div>

              {config.source === "csv" ? (
                <select
                  value={config.csvColumn}
                  onChange={(e) => updateParam(paramIndex, { csvColumn: e.target.value })}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
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
              ) : (
                <input
                  type="text"
                  value={config.manualValue}
                  onChange={(e) => updateParam(paramIndex, { manualValue: e.target.value })}
                  placeholder="Enter static value (same for all contacts)"
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Live Preview */}
      {templateBody && (
        <div className="mt-5 p-4 bg-green-50 rounded-lg border border-green-200">
          <p className="text-xs text-green-700 mb-2 font-medium">Message Preview:</p>
          <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{getPreview()}</p>
        </div>
      )}

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
