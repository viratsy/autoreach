"use client";

import { ExtraCampaign } from "@/app/campaigns/new/page";
import TemplatePreview from "./TemplatePreview";

/**
 * Parameter mapping for one additional campaign.
 *
 * Deliberately not sharing the primary campaign's mapping: parameter counts
 * genuinely differ between templates in the same workshop family (2, 3, 5 and
 * 7 all appear on hr_bi), so a shared mapping would be wrong far more often
 * than it would be convenient.
 */
export default function ExtraParamMapper({
  extra,
  csvHeaders,
  onChange,
}: {
  extra: ExtraCampaign;
  csvHeaders: string[];
  onChange: (mapping: Record<string, string>) => void;
}) {
  const count = extra.template.parameterCount || 0;
  const params = Array.from({ length: count }, (_, i) => String(i + 1));

  const bodyComponent = extra.template.components?.find(
    (c) => (c.type as string).toUpperCase() === "BODY"
  );
  const templateBody = (bodyComponent as unknown as { text?: string })?.text || "";

  const raw = (p: string) => extra.parameterMapping[p] || "";
  const isStatic = (p: string) => raw(p).startsWith("__STATIC__");
  const staticValue = (p: string) => raw(p).slice("__STATIC__".length);

  const set = (p: string, value: string) => onChange({ ...extra.parameterMapping, [p]: value });

  /** Fills any unmapped parameter whose number matches a CSV column position. */
  const autoMatch = () => {
    const mapping = { ...extra.parameterMapping };
    params.forEach((p, i) => {
      if (!mapping[p] && csvHeaders[i]) mapping[p] = csvHeaders[i];
    });
    onChange(mapping);
  };

  const resolved: Record<string, string> = {};
  params.forEach((p) => {
    resolved[p] = isStatic(p) ? staticValue(p) || "___" : raw(p) ? `[${raw(p)}]` : "___";
  });

  const mapped = params.filter((p) => raw(p)).length;

  return (
    <div className="border border-gray-200 rounded-xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <p className="text-sm font-medium text-gray-900">{extra.template.templateName}</p>
          <p className="text-xs text-gray-500">
            {count} parameter{count === 1 ? "" : "s"} · {mapped} of {count} mapped
          </p>
        </div>
        {count > 0 && (
          <button onClick={autoMatch} className="text-xs text-primary-600 hover:text-primary-700">
            Auto-match
          </button>
        )}
      </div>

      {count === 0 ? (
        <p className="text-xs text-gray-500">This template takes no parameters — nothing to map.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-5">
          <div className="space-y-3">
            {params.map((p) => (
              <div key={p} className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-gray-600 w-12 shrink-0">{`{{${p}}}`}</span>
                <select
                  value={isStatic(p) ? "__STATIC__" : raw(p)}
                  onChange={(e) =>
                    set(p, e.target.value === "__STATIC__" ? "__STATIC__" : e.target.value)
                  }
                  className="flex-1 min-w-[140px] border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm"
                >
                  <option value="">Select a CSV column…</option>
                  {csvHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                  <option value="__STATIC__">Same value for everyone…</option>
                </select>
                {isStatic(p) && (
                  <input
                    value={staticValue(p)}
                    onChange={(e) => set(p, `__STATIC__${e.target.value}`)}
                    placeholder="Value sent to every contact"
                    className="flex-1 min-w-[160px] border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm"
                  />
                )}
              </div>
            ))}
          </div>

          <div>
            {templateBody ? (
              <TemplatePreview
                template={extra.template}
                resolvedValues={resolved}
                headerImageUrl={extra.headerImageUrl}
              />
            ) : (
              <p className="text-xs text-gray-400 italic">
                No body text stored for this template — map the parameters in order.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
