"use client";

import { useState } from "react";
import { CampaignDraft } from "@/app/campaigns/new/page";
import ImagePicker from "./ImagePicker";
import TemplatePreview from "./TemplatePreview";
import ExtraParamMapper from "./ExtraParamMapper";

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

  // Whether the template itself needs a header image — same check
  // TemplatePreview already uses, and the only thing this UI should key off
  // of. numbersWithImageHeader (which numbers specifically) is populated by
  // two earlier, separate per-number fetches (SelectTemplate.tsx, then
  // SelectAdditionalNumbers.tsx) that can come back empty on a transient
  // failure — gating the whole picker on that array meant a blip in either
  // fetch silently hid the upload option even though the template clearly
  // needs an image (same signal the preview bubble already shows).
  const templateHasImageHeader = draft.template?.components?.some(
    (c) => (c.type as string).toUpperCase() === "HEADER" &&
      ((c as unknown as { format?: string }).format || "").toUpperCase() === "IMAGE"
  );

  // Track source type per parameter — seeded from the persisted draft so
  // coming back to this step (resumed draft, or clicking back from a later
  // step) shows exactly what was mapped before, not a blank form. A static
  // value is stored as `__STATIC__<value>`; without unwrapping that prefix
  // here, a resumed static mapping would render as a broken CSV-column
  // selection instead of the actual value.
  const [paramConfigs, setParamConfigs] = useState<Record<string, ParamConfig>>(() => {
    const initial: Record<string, ParamConfig> = {};
    params.forEach((p) => {
      const existing = draft.parameterMapping[p] || "";
      const isStatic = existing.startsWith("__STATIC__");
      initial[p] = {
        source: isStatic ? "manual" : "csv",
        csvColumn: isStatic ? "" : existing,
        manualValue: isStatic ? existing.slice("__STATIC__".length) : "",
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

  // Resolved display value per param index — feeds both the bubble preview
  // (TemplatePreview substitutes these into the body itself) and the plain
  // param-by-param fallback listing used when there's no template body text
  // to preview (AiSensy manual templates have no stored components; some
  // WATI shapes may not match Meta's {type, text} format).
  const getResolvedValues = (): Record<string, string> => {
    const values: Record<string, string> = {};
    params.forEach((p) => {
      const config = paramConfigs[p];
      if (config.source === "csv" && config.csvColumn) {
        values[p] = `[${config.csvColumn}]`;
      } else if (config.source === "manual" && config.manualValue) {
        values[p] = config.manualValue;
      } else {
        values[p] = "___";
      }
    });
    return values;
  };

  const allMapped = params.every((p) => {
    const config = paramConfigs[p];
    return (config.source === "csv" && config.csvColumn) ||
           (config.source === "manual" && config.manualValue);
  });

  // Each extra campaign carries its own mapping, and all of them must be
  // complete before any campaign is created — a half-mapped extra would send
  // a message with blank placeholders in it.
  const extrasMapped = draft.extraCampaigns.every((c) =>
    Array.from({ length: c.template.parameterCount || 0 }, (_, i) => String(i + 1)).every((p) => {
      const v = c.parameterMapping[p] || "";
      return v && v !== "__STATIC__";
    })
  );

  const updateExtra = (index: number, mapping: Record<string, string>) =>
    onUpdate({
      extraCampaigns: draft.extraCampaigns.map((c, i) =>
        i === index ? { ...c, parameterMapping: mapping } : c
      ),
    });

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Map Parameters</h3>
        <button onClick={autoMatch} className="text-sm text-primary-600 hover:text-primary-700">
          Auto-match
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
        <div>
          {/* Template info */}
          <div className="mb-5 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <p className="text-xs text-gray-500 font-medium">
              Template: <span className="text-gray-900">{draft.template?.templateName}</span>
              <span className="ml-2 text-gray-400">({paramCount} body parameters)</span>
            </p>
            {!templateBody && paramCount > 0 && (
              <p className="text-xs text-gray-400 mt-2 italic">
                Body text isn&apos;t available to preview for this provider — map the {paramCount} parameter{paramCount !== 1 ? "s" : ""} below in order.
              </p>
            )}
          </div>

          {/* Header Image — shown whenever the template needs one; which
              specific numbers get it (numbersWithImageHeader) is informational
              here, not a gate, since it can legitimately be a subset when a
              number has a different approved version of the same-named
              template without an image header. */}
          {templateHasImageHeader && (
            <div className="mb-5 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <label className="block text-sm font-medium text-blue-800 mb-1">
                Header Image
              </label>
              <p className="text-xs text-blue-600 mb-3">
                {draft.numbersWithImageHeader.length > 0
                  ? `Required for: ${draft.numbersWithImageHeader
                      .map((id) => draft.selectedNumbers.find((n) => n.phoneNumberId === id)?.displayName)
                      .join(", ")}`
                  : `Required for all ${draft.selectedNumbers.length} selected number${draft.selectedNumbers.length !== 1 ? "s" : ""}`}
              </p>
              <ImagePicker
                value={draft.headerImageUrl}
                onChange={(url) => onUpdate({ headerImageUrl: url })}
              />
            </div>
          )}

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
        </div>

        {/* Live preview — sticky alongside the form on desktop, stacks below on mobile */}
        <div className="lg:sticky lg:top-4 self-start">
          <TemplatePreview
            template={draft.template}
            resolvedValues={getResolvedValues()}
            headerImageUrl={draft.headerImageUrl}
          />
        </div>
      </div>

      {draft.extraCampaigns.length > 0 && (
        <div className="mt-6 space-y-4">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">
              {draft.extraCampaigns.length} more campaign{draft.extraCampaigns.length === 1 ? "" : "s"}
            </h4>
            <p className="text-xs text-gray-500">
              Same audience and numbers, each with its own template and parameters. Send times are
              set on the Review step.
            </p>
          </div>
          {draft.extraCampaigns.map((extra, i) => (
            <ExtraParamMapper
              key={extra.template.templateName}
              extra={extra}
              csvHeaders={draft.csvHeaders}
              onChange={(mapping) => updateExtra(i, mapping)}
            />
          ))}
        </div>
      )}

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!allMapped || !extrasMapped}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
