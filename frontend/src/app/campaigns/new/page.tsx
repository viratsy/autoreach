"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import StepIndicator from "@/components/campaign/StepIndicator";
import SelectBusiness from "@/components/campaign/SelectBusiness";
import SelectMainNumber from "@/components/campaign/SelectMainNumber";
import SelectTemplate from "@/components/campaign/SelectTemplate";
import SelectAdditionalNumbers from "@/components/campaign/SelectAdditionalNumbers";
import UploadCSV from "@/components/campaign/UploadCSV";
import MapParameters from "@/components/campaign/MapParameters";
import TestMessage from "@/components/campaign/TestMessage";
import ReviewSchedule from "@/components/campaign/ReviewSchedule";
import { Business, PhoneNumber, Template } from "@/types";
import { apiRequest } from "@/lib/api";

const STEPS = [
  "Select Business",
  "Select Main Number",
  "Select Template",
  "Add More Numbers",
  "Upload CSV",
  "Map Parameters",
  "Test Message",
  "Review & Schedule",
];

/**
 * One additional campaign created in the same pass — same business, numbers and
 * CSV as the primary, but its own template, parameter mapping, send time and
 * email choice. Parameter counts genuinely differ between templates in a
 * workshop family (2, 3, 5 and 7 all appear), so each carries its own mapping
 * rather than sharing the primary's.
 */
export interface ExtraCampaign {
  template: Template;
  parameterMapping: Record<string, string>;
  msg: string;
  scheduleDate: string;
  scheduleTime: string;
  emailEnabled: boolean;
  /** Which library email this campaign sends, chosen on Review. */
  emailTemplateId: string;
  headerImageUrl: string;
  numbersWithImageHeader: string[];
}

export interface CampaignDraft {
  business: Business | null;
  selectedNumbers: PhoneNumber[];
  csvFile: File | null;
  csvHeaders: string[];
  csvRowCount: number;
  csvS3Key: string;
  headerImageUrl: string;
  numbersWithImageHeader: string[];
  template: Template | null;
  templateMappings: Record<string, string>;
  parameterMapping: Record<string, string>;
  // Campaign name is built from these three (plus a unique id) rather than a
  // separate freeform prefix — keeps naming consistent and Total Cost grouping
  // exact, with no risk of the name and the grouping fields drifting apart.
  workshop: string;
  batch: string;
  msg: string;
  scheduleDate: string;
  scheduleTime: string;
  failureMode: string;
  autoRetry: boolean;
  respectUnsubscribeList: boolean;
  excludePaidUsers: boolean;
  emailEnabled: boolean;
  emailTemplateId: string;
  extraCampaigns: ExtraCampaign[];
}

const initialDraft: CampaignDraft = {
  business: null,
  selectedNumbers: [],
  csvFile: null,
  csvHeaders: [],
  csvRowCount: 0,
  csvS3Key: "",
  headerImageUrl: "",
  numbersWithImageHeader: [],
  template: null,
  templateMappings: {},
  parameterMapping: {},
  workshop: "",
  batch: "",
  msg: "",
  scheduleDate: "",
  scheduleTime: "",
  failureMode: "reroute",
  autoRetry: true,
  respectUnsubscribeList: true,
  excludePaidUsers: true,
  emailEnabled: false,
  emailTemplateId: "",
  extraCampaigns: [],
};

// Bumped whenever CampaignDraft's shape changes in an incompatible way, so
// an old saved draft from a previous version doesn't get force-fit into a
// mismatched shape — it's just dropped instead of crashing the page.
const DRAFT_STORAGE_KEY = "autoreach_campaign_draft_v2";

interface PersistedDraftState {
  version: number;
  step: number;
  maxStepReached: number;
  // `csvFile` (a File object) can't survive JSON — omitted. Once a file is
  // actually uploaded, csvS3Key/csvHeaders/csvRowCount already carry
  // everything the rest of the wizard needs, so losing the raw File
  // reference on reload is harmless; only an in-progress, not-yet-uploaded
  // selection would need re-picking.
  draft: Omit<CampaignDraft, "csvFile">;
}

function loadPersistedDraft(): { draft: CampaignDraft; step: number; maxStepReached: number } | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraftState;
    if (parsed.version !== 2 || !parsed.draft) return null;

    // Merged ONTO initialDraft rather than used as-is. A persisted draft is
    // whatever CampaignDraft looked like when it was saved, and the version
    // gate above was never bumped as fields were added — so a draft saved
    // before extraCampaigns existed came back without it, and SelectTemplate's
    // `draft.extraCampaigns.some(...)` threw on undefined, crashing the whole
    // wizard with "a client-side exception has occurred". Merging gives every
    // field added since the draft was saved its default, which fixes this for
    // future fields too instead of only the ones that have bitten us.
    const merged = { ...initialDraft, ...parsed.draft, csvFile: null } as CampaignDraft;

    // Belt and braces for the arrays specifically: the spread only fills in
    // MISSING keys, so a persisted null would still reach a .map/.some call.
    if (!Array.isArray(merged.extraCampaigns)) merged.extraCampaigns = [];
    if (!Array.isArray(merged.selectedNumbers)) merged.selectedNumbers = [];
    if (!Array.isArray(merged.numbersWithImageHeader)) merged.numbersWithImageHeader = [];
    if (!Array.isArray(merged.csvHeaders)) merged.csvHeaders = [];

    return { draft: merged, step: parsed.step || 0, maxStepReached: parsed.maxStepReached || 0 };
  } catch {
    return null;
  }
}

function savePersistedDraft(draft: CampaignDraft, step: number, maxStepReached: number) {
  try {
    const { csvFile: _csvFile, ...rest } = draft;
    const payload: PersistedDraftState = { version: 2, step, maxStepReached, draft: rest };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full/unavailable — the wizard still works, it just won't resume after a reload.
  }
}

function clearPersistedDraft() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {}
}

export default function NewCampaignPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading...</div>}>
      <NewCampaignContent />
    </Suspense>
  );
}

function NewCampaignContent() {
  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");
  const [step, setStep] = useState(0);
  const [maxStepReached, setMaxStepReached] = useState(0);
  const [draft, setDraft] = useState<CampaignDraft>(initialDraft);
  const [loadingDraft, setLoadingDraft] = useState(Boolean(editId));
  const [loadError, setLoadError] = useState("");
  const [resumedDraft, setResumedDraft] = useState(false);

  // Resume an in-progress draft on load — but only for a genuinely fresh
  // "new campaign" visit, never when editing an existing saved campaign.
  useEffect(() => {
    if (editId) {
      loadDraftCampaign(editId);
      return;
    }
    const persisted = loadPersistedDraft();
    if (persisted && (persisted.draft.business || persisted.step > 0)) {
      setDraft(persisted.draft);
      setStep(persisted.step);
      setMaxStepReached(persisted.maxStepReached);
      setResumedDraft(true);
    }
  }, [editId]);

  // Persist on every change, so navigating away (or an accidental reload)
  // mid-wizard doesn't lose progress — this was resetting to a blank draft
  // every time before.
  useEffect(() => {
    if (editId || loadingDraft) return;
    savePersistedDraft(draft, step, maxStepReached);
  }, [draft, step, maxStepReached, editId, loadingDraft]);

  async function loadDraftCampaign(campaignId: string) {
    setLoadingDraft(true);
    setLoadError("");
    try {
      const data = await apiRequest<{ campaign: any }>(`/campaigns/${campaignId}`);
      const c = data.campaign;

      // Load business details
      let business: any = null;
      if (c.businessId) {
        const bizData = await apiRequest<{ businesses: any[] }>("/businesses");
        business = bizData.businesses.find((b: any) => b.businessId === c.businessId) || null;
      }

      const selectedNumbers = c.selectedNumbers || [];

      // Re-fetch the full template (with components) so the wizard's preview
      // and the eventual submit both have what they need — GET /campaigns/{id}
      // only stores the template's name, not its body/header/buttons.
      let template: any = null;
      if (c.businessId && c.templateName && selectedNumbers.length > 0) {
        try {
          const phoneIds = selectedNumbers.map((n: any) => n.phoneNumberId).join(",");
          const tplData = await apiRequest<{ templates: any[] }>(
            `/templates?businessId=${c.businessId}&phoneNumberIds=${phoneIds}`
          );
          const tpl = tplData.templates.find((t) => t.templateName === c.templateName);
          if (tpl) {
            template = {
              templateName: tpl.templateName,
              language: "en_US",
              category: c.templateCategory || tpl.category,
              components: tpl.components,
              parameterCount: tpl.parameterCount,
              status: "approved",
              lastSyncedAt: "",
            };
          }
        } catch {
          // Template lookup failing shouldn't block loading the rest of the draft —
          // the user can still re-pick a template on the Select Template step.
        }
      }

      setDraft((prev) => ({
        ...prev,
        business,
        template,
        workshop: c.workshop || "",
        batch: c.batch || "",
        msg: c.msg || "",
        emailEnabled: c.emailEnabled === true,
        emailTemplateId: c.emailTemplateId || "",
        csvS3Key: c.csvS3Key || "",
        csvRowCount: c.totalContacts || 0,
        headerImageUrl: c.headerImageUrl || "",
        numbersWithImageHeader: c.numbersWithImageHeader || [],
        templateMappings: c.templateMappings || {},
        parameterMapping: c.parameterMapping || {},
        scheduleDate: c.scheduleDate || "",
        scheduleTime: c.scheduleTime || "",
        failureMode: c.failureMode || "reroute",
        autoRetry: c.autoRetry !== false,
        respectUnsubscribeList: c.respectUnsubscribeList !== false,
        excludePaidUsers: c.excludePaidUsers !== false,
        selectedNumbers,
      }));
      // Jump to Review & Schedule (last step) — user can go back if needed
      setStep(STEPS.length - 1);
      setMaxStepReached(STEPS.length - 1);
    } catch (err) {
      console.error("Failed to load campaign for edit:", err);
      setLoadError(err instanceof Error ? err.message : "Failed to load campaign");
    } finally {
      setLoadingDraft(false);
    }
  }

  const updateDraft = (updates: Partial<CampaignDraft>) => {
    setDraft((prev) => ({ ...prev, ...updates }));
  };

  const goToStep = (index: number) => {
    setStep(index);
    setMaxStepReached((prev) => Math.max(prev, index));
  };

  const startOver = () => {
    clearPersistedDraft();
    setDraft(initialDraft);
    setStep(0);
    setMaxStepReached(0);
    setResumedDraft(false);
  };

  const renderStep = () => {
    switch (step) {
      case 0:
        return <SelectBusiness draft={draft} onUpdate={updateDraft} onNext={() => goToStep(1)} />;
      case 1:
        return <SelectMainNumber draft={draft} onUpdate={updateDraft} onNext={() => goToStep(2)} onBack={() => goToStep(0)} />;
      case 2:
        return <SelectTemplate draft={draft} onUpdate={updateDraft} onNext={() => goToStep(3)} onBack={() => goToStep(1)} />;
      case 3:
        return <SelectAdditionalNumbers draft={draft} onUpdate={updateDraft} onNext={() => goToStep(4)} onBack={() => goToStep(2)} />;
      case 4:
        return <UploadCSV draft={draft} onUpdate={updateDraft} onNext={() => goToStep(5)} onBack={() => goToStep(3)} />;
      case 5:
        return <MapParameters draft={draft} onUpdate={updateDraft} onNext={() => goToStep(6)} onBack={() => goToStep(4)} />;
      case 6:
        return <TestMessage draft={draft} onUpdate={updateDraft} onNext={() => goToStep(7)} onBack={() => goToStep(5)} />;
      case 7:
        return <ReviewSchedule draft={draft} onUpdate={updateDraft} onBack={() => goToStep(6)} editCampaignId={editId} onSubmitted={clearPersistedDraft} />;
      default:
        return null;
    }
  };

  return (
    <AuthGuard>
    <AppShell>
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-2xl font-bold text-gray-900">
              {editId ? "Edit Campaign" : "Create Campaign"}
            </h2>
            {!editId && (step > 0 || draft.business) && (
              <button onClick={startOver} className="text-xs text-gray-400 hover:text-gray-600">
                Start Over
              </button>
            )}
          </div>
          {editId && !loadError && (
            <p className="text-sm text-gray-500 mb-5">Editing draft — changes save back to this same campaign.</p>
          )}
          {!editId && resumedDraft && (
            <p className="text-sm text-primary-600 mb-5">Resumed your in-progress draft.</p>
          )}
          {loadError && (
            <div className="mb-5 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              Couldn&apos;t load this draft for editing: {loadError}
            </div>
          )}
          {loadingDraft ? (
            <p className="text-sm text-gray-400 mt-6">Loading draft...</p>
          ) : (
            <>
              <StepIndicator steps={STEPS} currentStep={step} maxStepReached={maxStepReached} onStepClick={goToStep} />
              <div className="mt-8">{renderStep()}</div>
            </>
          )}
        </div>
    </AppShell>
    </AuthGuard>
  );
}
