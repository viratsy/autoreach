"use client";

import { useEffect, useState } from "react";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { apiRequest } from "@/lib/api";
import { AlertTriangle, RefreshCw, Search, ExternalLink } from "lucide-react";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

interface TemplateInfo {
  templateName: string;
  category: string;
  parameterCount: number;
  components: { type: string; text?: string }[];
  availableOn: string[];
}

export default function SelectTemplate({ draft, onUpdate, onNext, onBack }: Props) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [mismatchNumbers, setMismatchNumbers] = useState<string[]>([]);

  const selectedNumberIds = draft.selectedNumbers.map((n) => n.phoneNumberId);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        businessId: draft.business!.businessId,
        phoneNumberIds: selectedNumberIds.join(","),
      });
      const data = await apiRequest<{ templates: TemplateInfo[] }>(`/templates?${params}`);
      setTemplates(data.templates);
    } catch {
      // Templates not synced yet
    } finally {
      setLoading(false);
    }
  };

  const syncTemplates = async () => {
    setSyncing(true);
    try {
      await apiRequest("/templates/fetch", {
        method: "POST",
        body: JSON.stringify({ businessId: draft.business!.businessId }),
      });
      await loadTemplates();
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  };

  const handleSelect = (tpl: TemplateInfo) => {
    const mismatches = selectedNumberIds.filter(
      (id) => !tpl.availableOn.includes(id)
    );
    setMismatchNumbers(mismatches);
    onUpdate({
      template: {
        templateName: tpl.templateName,
        language: "en",
        category: tpl.category,
        components: tpl.components as unknown as import("@/types").TemplateComponent[],
        parameterCount: tpl.parameterCount,
        status: "approved",
        lastSyncedAt: "",
      },
      templateMappings: {},
    });
  };

  const handleMapping = (phoneNumberId: string, altTemplateName: string) => {
    onUpdate({
      templateMappings: { ...draft.templateMappings, [phoneNumberId]: altTemplateName },
    });
  };

  const filteredTemplates = templates.filter((tpl) =>
    tpl.templateName.toLowerCase().includes(search.toLowerCase())
  );

  const canProceed =
    draft.template && mismatchNumbers.every((id) => draft.templateMappings[id]);

  // Get number name by ID
  const getNumberName = (phoneNumberId: string) => {
    return draft.selectedNumbers.find((n) => n.phoneNumberId === phoneNumberId)?.displayName || phoneNumberId;
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Select Template</h3>
        <div className="flex items-center gap-3">
          <a
            href={`https://business.facebook.com/latest/whatsapp_manager/message_templates?business_id=${draft.business?.businessId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
          >
            <ExternalLink className="w-3 h-3" />
            WhatsApp Manager
          </a>
          <button
            onClick={syncTemplates}
            disabled={syncing}
            className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync from Meta"}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates..."
          className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm py-4">Loading templates...</p>
      ) : templates.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500 text-sm">No templates found.</p>
          <p className="text-gray-400 text-xs mt-1">Click &quot;Sync from Meta&quot; to fetch templates.</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {filteredTemplates.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-4">No templates match &quot;{search}&quot;</p>
          ) : (
            filteredTemplates.map((tpl) => (
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
                <p className="text-xs text-gray-500 mt-1">
                  {tpl.parameterCount} parameters • Available on {tpl.availableOn.length}/{selectedNumberIds.length} numbers
                </p>
                {/* Show which numbers have this template */}
                <div className="flex flex-wrap gap-1 mt-2">
                  {selectedNumberIds.map((id) => (
                    <span
                      key={id}
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        tpl.availableOn.includes(id)
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {getNumberName(id)} {tpl.availableOn.includes(id) ? "✓" : "✗"}
                    </span>
                  ))}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {mismatchNumbers.length > 0 && (
        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600" />
            <p className="text-sm font-medium text-yellow-700">Template not available on all numbers</p>
          </div>
          <p className="text-xs text-yellow-600 mb-3">
            Map an alternative template for these numbers:
          </p>
          {mismatchNumbers.map((phoneId) => (
            <div key={phoneId} className="flex items-center gap-3 mt-2">
              <span className="text-xs text-gray-700 w-24 truncate">{getNumberName(phoneId)}</span>
              <span className="text-gray-400">→</span>
              <input
                type="text"
                placeholder="Alternative template name"
                value={draft.templateMappings[phoneId] || ""}
                onChange={(e) => handleMapping(phoneId, e.target.value)}
                className="flex-1 text-sm border border-gray-300 rounded px-3 py-1.5"
              />
            </div>
          ))}
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
