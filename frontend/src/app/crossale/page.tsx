"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import StepIndicator from "@/components/campaign/StepIndicator";
import DateRangeBatchPicker, { BatchGroup } from "@/components/crossale/DateRangeBatchPicker";
import WorkshopBatchDetails from "@/components/crossale/WorkshopBatchDetails";
import SelectRunKeys, { RunKeySelection } from "@/components/crossale/SelectRunKeys";
import CrossaleReview from "@/components/crossale/CrossaleReview";
import ConfirmDialog, { ConfirmDialogState } from "@/components/shared/ConfirmDialog";

const STEPS = ["Pick Date Range", "Confirm Workshop & Date", "Select Run Keys", "Review & Create"];
const DRAFT_KEY = "autoreach_crossale_draft_v2";

/** One past workshop contributing attendees to the pooled audience. */
export interface AudienceSource {
  wsCode: string;
  workshopName: string;
  batchDates: string[];
  audienceCount: number;
}

export interface WorkshopEntry {
  // Every selected batch, pooled into one audience and deduped by phone
  // server-side — so one promotion can go to attendees of several past
  // workshops at once, rather than one run per source workshop.
  sources: AudienceSource[];
  audienceCount: number;
  businessId: string;
  promotedDate: string;
  promotedTime: string; // "11:00" | "19:00"
  zoomLink: string;
  whatsappGroup: string;
  runKeys: RunKeySelection[];
  mode: "auto" | "manual";
  // The workshop actually being promoted — independent of wsCode (the
  // audience source). Defaults to the source but is freely changeable, so
  // e.g. a Generative AI Tools audience can be invited to Claude AI.
  targetWsCode: string;
  targetWorkshopName: string;
}

export interface CreatedCampaign {
  campaignId: string;
  campaignName: string;
  runKey: string;
  workshopName: string;
  scheduleDate: string;
  scheduleTime: string;
}

interface PersistedDraft {
  step: number;
  maxStepReached: number;
  entry: WorkshopEntry | null;
  createdAll: CreatedCampaign[];
  warnings: string[];
  done: boolean;
}

function loadDraft(): PersistedDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as PersistedDraft) : null;
  } catch {
    return null;
  }
}

export default function CrossalePage() {
  const [step, setStep] = useState(0);
  const [maxStepReached, setMaxStepReached] = useState(0);
  const [entry, setEntry] = useState<WorkshopEntry | null>(null);
  const [createdAll, setCreatedAll] = useState<CreatedCampaign[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [resumed, setResumed] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const runConfirmed = async () => {
    if (!confirmState) return;
    setConfirmLoading(true);
    try {
      await confirmState.onConfirm();
    } finally {
      setConfirmLoading(false);
      setConfirmState(null);
    }
  };

  useEffect(() => {
    const draft = loadDraft();
    if (draft && draft.entry) {
      setStep(draft.step);
      setMaxStepReached(draft.maxStepReached);
      setEntry(draft.entry);
      setCreatedAll(draft.createdAll);
      setWarnings(draft.warnings);
      setDone(draft.done);
      setResumed(true);
    }
    setLoadingDraft(false);
  }, []);

  useEffect(() => {
    if (loadingDraft) return;
    const draft: PersistedDraft = { step, maxStepReached, entry, createdAll, warnings, done };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [step, maxStepReached, entry, createdAll, warnings, done, loadingDraft]);

  const startOver = () => {
    localStorage.removeItem(DRAFT_KEY);
    setStep(0);
    setMaxStepReached(0);
    setEntry(null);
    setCreatedAll([]);
    setWarnings([]);
    setDone(false);
    setResumed(false);
  };

  const goToStep = (index: number) => {
    setStep(index);
    setMaxStepReached((prev) => Math.max(prev, index));
  };

  const updateCurrent = (updates: Partial<WorkshopEntry>) => {
    setEntry((prev) => (prev ? { ...prev, ...updates } : prev));
  };

  const handleBatchesSelected = (groups: BatchGroup[]) => {
    // Group only to keep each source's batch dates together for display and
    // for the API's `sources` list — the audience itself is the union of all
    // of them, deduped by phone server-side.
    const byWs = new Map<string, BatchGroup[]>();
    groups.forEach((g) => {
      if (!byWs.has(g.wsCode)) byWs.set(g.wsCode, []);
      byWs.get(g.wsCode)!.push(g);
    });
    const sources: AudienceSource[] = Array.from(byWs.entries()).map(([wsCode, gs]) => ({
      wsCode,
      workshopName: gs[0].workshopName,
      batchDates: gs.map((g) => g.firstBatchDate),
      audienceCount: gs.reduce((sum, g) => sum + g.total, 0),
    }));

    // Only a single source can supply a sensible default target; with several
    // pooled, the target is a deliberate choice made on the next step.
    const soleSource = sources.length === 1 ? sources[0] : null;

    setEntry((prev) => ({
      sources,
      audienceCount: sources.reduce((sum, srv) => sum + srv.audienceCount, 0),
      businessId: prev?.businessId || "",
      promotedDate: prev?.promotedDate || "",
      promotedTime: prev?.promotedTime || "19:00",
      zoomLink: prev?.zoomLink || "",
      whatsappGroup: prev?.whatsappGroup || "",
      runKeys: prev?.runKeys || [],
      mode: prev?.mode || "auto",
      targetWsCode: prev?.targetWsCode || soleSource?.wsCode || "",
      targetWorkshopName: prev?.targetWorkshopName || soleSource?.workshopName || "",
    }));
    goToStep(1);
  };

  const handleCreated = (result: { created: Omit<CreatedCampaign, "workshopName">[]; warnings: string[] }) => {
    setCreatedAll((prev) => [
      ...prev,
      ...result.created.map((c) => ({ ...c, workshopName: entry?.targetWorkshopName || "" })),
    ]);
    setWarnings((prev) => [...prev, ...result.warnings]);
    setDone(true);
  };

  if (loadingDraft) return null;

  return (
    <AuthGuard>
      <AppShell mainClassName="flex-1 overflow-y-auto p-4 pt-20 md:p-6 bg-gray-50">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Crossale</h2>
              <p className="text-sm text-gray-500 mt-1">Promote past workshop attendees into a new batch.</p>
            </div>
            {(entry || done) && (
              <button onClick={startOver} className="text-sm text-gray-500 hover:text-red-600">
                Start Over
              </button>
            )}
          </div>

          {resumed && !done && <p className="text-xs text-primary-600 mb-4">Resumed your in-progress draft.</p>}

          {done ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center shadow-sm">
              <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
              <h3 className="text-lg font-semibold text-gray-900 mb-1">
                {createdAll.length} campaign{createdAll.length === 1 ? "" : "s"} created
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                for {createdAll[0]?.workshopName || "the selected workshop"}
              </p>
              {warnings.length > 0 && (
                <div className="text-left bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-xs text-amber-700 space-y-1">
                  {warnings.map((w, i) => (
                    <p key={i}>{w}</p>
                  ))}
                </div>
              )}
              {createdAll.length > 0 && (
                <div className="text-left divide-y divide-gray-100 border border-gray-100 rounded-lg mb-6">
                  {createdAll.map((c) => (
                    <div key={c.campaignId} className="px-4 py-2.5 flex items-center justify-between text-sm">
                      <span className="text-gray-900">{c.campaignName}</span>
                      <span className="text-gray-400">
                        {c.workshopName} · {c.runKey} · {c.scheduleDate} {c.scheduleTime}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-center gap-3">
                <Link
                  href="/campaigns"
                  className="px-5 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-medium hover:bg-primary-700"
                >
                  View in Campaigns
                </Link>
                <button onClick={startOver} className="px-5 py-2.5 text-gray-600 text-sm font-medium hover:text-gray-900">
                  Start Another
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <StepIndicator steps={STEPS} currentStep={step} maxStepReached={maxStepReached} onStepClick={goToStep} />
              </div>

              {step > 0 && entry && entry.sources.length > 1 && (
                <p className="text-sm font-medium text-primary-700 bg-primary-50 border border-primary-100 rounded-lg px-3 py-2 mb-4">
                  Audience pooled from {entry.sources.length} workshops:{" "}
                  <span className="font-normal text-primary-600">
                    {entry.sources.map((src) => src.workshopName).join(", ")} — {entry.audienceCount} registered,
                    deduplicated by phone
                  </span>
                </p>
              )}

              {step === 0 && <DateRangeBatchPicker onNext={handleBatchesSelected} />}
              {step === 1 && entry && (
                <WorkshopBatchDetails entry={entry} onUpdate={updateCurrent} onNext={() => goToStep(2)} onBack={() => goToStep(0)} />
              )}
              {step === 2 && entry && (
                <SelectRunKeys entry={entry} onUpdate={updateCurrent} onNext={() => goToStep(3)} onBack={() => goToStep(1)} />
              )}
              {step === 3 && entry && (
                <CrossaleReview entry={entry} onCreated={handleCreated} onBack={() => goToStep(2)} />
              )}
            </>
          )}

          <ConfirmDialog
            state={confirmState}
            loading={confirmLoading}
            onConfirm={runConfirmed}
            onCancel={() => setConfirmState(null)}
          />
        </div>
      </AppShell>
    </AuthGuard>
  );
}
