"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { apiRequest } from "@/lib/api";
import TimePicker12h from "./TimePicker12h";
import TemplatePreview from "./TemplatePreview";
import TestNumbersPanel from "@/components/shared/TestNumbersPanel";
import EmailChannelPanel from "./EmailChannelPanel";
import ExtraCampaignSchedule from "./ExtraCampaignSchedule";
import { Zap, Clock, AlertTriangle, Mail } from "lucide-react";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onBack: () => void;
  // Set when this wizard was opened via "Edit"/"Duplicate" on an existing
  // draft — submit then PUTs that same campaign in place instead of POSTing
  // a brand-new one, so editing a draft doesn't pile up orphaned copies.
  editCampaignId?: string | null;
  // Called once the campaign is actually created/updated, so the
  // resume-in-progress-draft saved in localStorage doesn't linger and get
  // offered again on the next visit to "Create Campaign".
  onSubmitted?: () => void;
}

// Mirrors backend/src/lib/capacity.ts — kept in sync manually since frontend and
// backend are separate TS projects. Numbers are now genuinely rate-capped per
// number (FIFO per-number serialization in send.ts/send-worker.ts), so this
// estimate reflects what a campaign will actually do, not an aspirational number.
const SAFE_MSGS_PER_SECOND = 5;
const TIER_CAPS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_10K: 10000,
  TIER_100K: 100000,
  TIER_UNLIMITED: Infinity,
};
const CONSERVATIVE_DEFAULT_TIER_CAP = TIER_CAPS.TIER_50;

function estimateCapacity(totalContacts: number, numbers: { messagingLimit?: string }[], targetMinutes?: number) {
  const numberCount = numbers.length;
  const estimatedMinutes = numberCount === 0 || totalContacts === 0 ? 0 : totalContacts / (SAFE_MSGS_PER_SECOND * numberCount * 60);
  const numbersNeededForTarget = targetMinutes && targetMinutes > 0
    ? Math.max(1, Math.ceil(totalContacts / (SAFE_MSGS_PER_SECOND * targetMinutes * 60)))
    : undefined;
  const aggregateDailyCapacity = numbers.reduce((sum, n) => {
    const cap = n.messagingLimit ? TIER_CAPS[n.messagingLimit] ?? CONSERVATIVE_DEFAULT_TIER_CAP : CONSERVATIVE_DEFAULT_TIER_CAP;
    return sum + cap;
  }, 0);
  return {
    estimatedMinutes,
    numbersNeededForTarget,
    aggregateDailyCapacity,
    exceedsAggregateCapacity: totalContacts > aggregateDailyCapacity,
  };
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `~${Math.ceil(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `~${hours}h ${mins}m`;
}

function formatTime12h(date: Date): string {
  let h = date.getHours();
  const m = date.getMinutes();
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${period}`;
}

// Same wall-clock arithmetic already used elsewhere in this component (the
// "at least 5 minutes from now" check) — scheduleDate/scheduleTime are treated as
// IST wall-clock values, not converted through any timezone, so adding minutes and
// reformatting stays correct regardless of the browser's own timezone.
function computeEta(scheduleDate: string, scheduleTime: string, estimatedMinutes: number): { time: string; nextDay: boolean } | null {
  if (!scheduleDate || !scheduleTime) return null;
  const start = new Date(`${scheduleDate}T${scheduleTime}:00`);
  if (isNaN(start.getTime())) return null;
  const eta = new Date(start.getTime() + estimatedMinutes * 60 * 1000);
  return { time: formatTime12h(eta), nextDay: eta.toDateString() !== start.toDateString() };
}

export default function ReviewSchedule({ draft, onUpdate, onBack, editCampaignId, onSubmitted }: Props) {
  const router = useRouter();
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState("");
  const [targetMinutes, setTargetMinutes] = useState(5);
  const provider = draft.business?.provider || "meta";

  // Final preview uses a REAL row from the uploaded CSV rather than the
  // "[column_name]" placeholders shown back in Map Parameters — this is the
  // last checkpoint before thousands of people receive it, so the useful
  // question is "what does an actual recipient see", including whether a
  // mapped column is empty or holds something unexpected.
  const [sampleRow, setSampleRow] = useState<Record<string, string> | null>(null);
  const [sampleError, setSampleError] = useState(false);

  useEffect(() => {
    if (!draft.csvS3Key) return;
    apiRequest<{ preview?: Record<string, string>[] }>(
      `/campaigns/file-preview?s3Key=${encodeURIComponent(draft.csvS3Key)}`
    )
      .then((d) => setSampleRow(d.preview?.[0] || null))
      .catch(() => setSampleError(true));
  }, [draft.csvS3Key]);

  // Mirrors send-worker.ts: a mapping value prefixed __STATIC__ is a literal,
  // anything else is a CSV column name.
  const previewValues: Record<string, string> = {};
  Object.entries(draft.parameterMapping || {}).forEach(([idx, mapped]) => {
    if (typeof mapped === "string" && mapped.startsWith("__STATIC__")) {
      previewValues[idx] = mapped.replace("__STATIC__", "") || "___";
    } else if (sampleRow && mapped in sampleRow) {
      previewValues[idx] = String(sampleRow[mapped] ?? "").trim() || "(empty)";
    } else {
      previewValues[idx] = mapped ? `[${mapped}]` : "___";
    }
  });
  const isMeta = provider === "meta";
  const capacity = estimateCapacity(draft.csvRowCount, draft.selectedNumbers, targetMinutes);

  // Shared submit — both "Schedule Campaign" and "Send Now" hit the same endpoint,
  // just with different scheduleDate/scheduleTime. Takes them as params rather than
  // reading draft.* directly so "Send Now" doesn't have to wait a render cycle for
  // onUpdate() to land before submitting.
  const submitCampaign = async (scheduleDate: string, scheduleTime: string, opts?: { skipFutureCheck?: boolean }) => {
    if (!opts?.skipFutureCheck) {
      const now = new Date();
      const scheduled = new Date(`${scheduleDate}T${scheduleTime}:00`);
      const minTime = new Date(now.getTime() + 5 * 60 * 1000);
      if (scheduled < minTime) {
        setError("Schedule must be at least 5 minutes from now");
        return;
      }
    }

    setScheduling(true);
    setError("");

    // Last-checkpoint safety net: if the user uploaded a header image (proof
    // they intend one) but numbersWithImageHeader somehow ended up empty —
    // an upstream per-number availability fetch failing silently is the
    // known way that happens — fall back to every selected number rather
    // than silently sending the template with no image to any of them.
    const templateHasImageHeader = draft.template?.components?.some(
      (c) => (c.type as string).toUpperCase() === "HEADER" &&
        ((c as unknown as { format?: string }).format || "").toUpperCase() === "IMAGE"
    );
    const numbersWithImageHeader =
      draft.headerImageUrl && templateHasImageHeader && draft.numbersWithImageHeader.length === 0
        ? draft.selectedNumbers.map((n) => n.phoneNumberId)
        : draft.numbersWithImageHeader;

    try {
      await apiRequest<{ campaignId: string; campaignName: string }>(
        editCampaignId ? `/campaigns/${editCampaignId}` : "/campaigns",
        {
          method: editCampaignId ? "PUT" : "POST",
          body: JSON.stringify({
            campaignPrefix: [draft.workshop, draft.batch, draft.msg].filter(Boolean).join("_"),
            businessId: draft.business!.businessId,
            businessName: draft.business!.businessName,
            selectedNumbers: draft.selectedNumbers,
            templateName: draft.template!.templateName,
            templateCategory: draft.template!.category,
            templateMappings: draft.templateMappings,
            parameterMapping: draft.parameterMapping,
            headerImageUrl: draft.headerImageUrl || undefined,
            numbersWithImageHeader,
            csvS3Key: draft.csvS3Key,
            totalContacts: draft.csvRowCount,
            scheduleDate,
            scheduleTime,
            failureMode: draft.failureMode,
            autoRetry: draft.autoRetry,
            respectUnsubscribeList: (draft as unknown as { respectUnsubscribeList?: boolean }).respectUnsubscribeList,
            excludePaidUsers: (draft as unknown as { excludePaidUsers?: boolean }).excludePaidUsers,
            workshop: draft.workshop,
            batch: draft.batch,
            msg: draft.msg,
            emailEnabled: draft.emailEnabled,
            emailTemplateId: draft.emailTemplateId || undefined,
          }),
        }
      );

      // Extras are created after the primary, one at a time: if the third of
      // five fails, the user needs to know which two exist rather than being
      // told "something failed" about an unknown subset.
      const failed: string[] = [];
      for (const extra of draft.extraCampaigns) {
        const label = extra.msg || extra.template.templateName;
        try {
          await apiRequest("/campaigns", {
            method: "POST",
            body: JSON.stringify({
              campaignPrefix: [draft.workshop, draft.batch, label].filter(Boolean).join("_"),
              businessId: draft.business!.businessId,
              businessName: draft.business!.businessName,
              selectedNumbers: draft.selectedNumbers,
              templateName: extra.template.templateName,
              templateCategory: extra.template.category,
              // Left empty on purpose — send-worker falls back to templateName
              // for any number without an explicit mapping, and per-number
              // remapping is only ever set up for the primary template.
              templateMappings: {},
              parameterMapping: extra.parameterMapping,
              headerImageUrl: extra.headerImageUrl || undefined,
              numbersWithImageHeader: extra.numbersWithImageHeader,
              csvS3Key: draft.csvS3Key,
              totalContacts: draft.csvRowCount,
              scheduleDate: extra.scheduleDate || scheduleDate,
              scheduleTime: extra.scheduleTime,
              failureMode: draft.failureMode,
              autoRetry: draft.autoRetry,
              respectUnsubscribeList: draft.respectUnsubscribeList,
              excludePaidUsers: draft.excludePaidUsers,
              emailEnabled: extra.emailEnabled,
              emailTemplateId: extra.emailTemplateId || undefined,
              workshop: draft.workshop,
              batch: draft.batch,
              msg: label,
            }),
          });
        } catch (err) {
          failed.push(`${label}: ${err instanceof Error ? err.message : "failed"}`);
        }
      }

      if (failed.length) {
        setError(
          `The first campaign was created, but ${failed.length} of ${draft.extraCampaigns.length} extra campaigns failed — ${failed.join("; ")}`
        );
        setScheduling(false);
        return;
      }

      // Redirect to campaigns list with success
      onSubmitted?.();
      router.push("/campaigns");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule campaign");
    } finally {
      setScheduling(false);
    }
  };

  const handleSchedule = () => submitCampaign(draft.scheduleDate, draft.scheduleTime);

  // Every extra needs a time of its own; a date can be inherited from the
  // primary but a time cannot be guessed.
  const extrasScheduled = draft.extraCampaigns.every(
    (c) => (c.scheduleDate || draft.scheduleDate) && c.scheduleTime
  );

  // "Send Now" reuses the exact same EventBridge-schedule code path as a normal
  // schedule — just targets ~90s from now (IST) instead of a picked date/time. A
  // schedule needs to be created for a moment slightly in the future; a few seconds
  // of buffer avoids a race against clock skew between browser and AWS, and is
  // imperceptible for "send now" purposes.
  const handleSendNow = () => {
    const istMs = Date.now() + 5.5 * 60 * 60 * 1000 + 90 * 1000;
    const ist = new Date(istMs);
    const scheduleDate = ist.toISOString().slice(0, 10);
    const scheduleTime = ist.toISOString().slice(11, 16);
    onUpdate({ scheduleDate, scheduleTime });
    submitCampaign(scheduleDate, scheduleTime, { skipFutureCheck: true });
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Review & Schedule</h3>

      {/* Campaign Name — built from Workshop + Batch + Message + a unique id,
          rather than a separate freeform prefix. Keeps naming consistent across
          every campaign and makes Total Cost grouping exact by construction. */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">Campaign Name</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Workshop</label>
            <input
              type="text"
              value={draft.workshop}
              onChange={(e) => onUpdate({ workshop: e.target.value })}
              placeholder="e.g. AI Tools"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Batch</label>
            <input
              type="text"
              value={draft.batch}
              onChange={(e) => onUpdate({ batch: e.target.value })}
              placeholder="e.g. B188"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Message</label>
            <input
              type="text"
              value={draft.msg}
              onChange={(e) => onUpdate({ msg: e.target.value })}
              placeholder="e.g. 1 Hour"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Final name: {[draft.workshop, draft.batch, draft.msg].filter(Boolean).join("_") || "workshop_batch_msg"}_xxxxxx
        </p>
      </div>

      {/* Chosen and tested on the Test Message step — shown here read-only so
          Review stays a summary of what is about to happen. */}
      <div className="mb-6 flex items-center justify-between gap-4 px-4 py-3 border border-gray-200 rounded-xl">
        <div className="flex items-center gap-3 min-w-0">
          <Mail className="w-5 h-5 text-gray-500 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Also send by email</p>
            <p className="text-xs text-gray-500 truncate">
              {draft.emailEnabled && draft.emailTemplateId
                ? `Goes to the same ${draft.csvRowCount.toLocaleString()} contacts at the scheduled time`
                : "Off — turn it on and pick a template on the Test Message step"}
            </p>
          </div>
        </div>
        <span
          className={`text-xs font-medium shrink-0 ${
            draft.emailEnabled && draft.emailTemplateId ? "text-green-700" : "text-gray-400"
          }`}
        >
          {draft.emailEnabled && draft.emailTemplateId ? "On" : "Off"}
        </span>
      </div>

      {draft.extraCampaigns.length > 0 && (
        <div className="mb-6 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">
              {draft.extraCampaigns.length} more campaign
              {draft.extraCampaigns.length === 1 ? "" : "s"}
            </h4>
            <p className="text-xs text-gray-500">
              Each gets its own send time and email choice. They share this campaign&apos;s audience,
              numbers and CSV.
            </p>
          </div>
          {draft.extraCampaigns.map((extra, i) => (
            <ExtraCampaignSchedule
              key={extra.template.templateName}
              extra={extra}
              workshop={draft.workshop}
              batch={draft.batch}
              defaultDate={draft.scheduleDate}
              csvS3Key={draft.csvS3Key}
              contactCount={draft.csvRowCount}
              onChange={(updates) =>
                onUpdate({
                  extraCampaigns: draft.extraCampaigns.map((c, n) =>
                    n === i ? { ...c, ...updates } : c
                  ),
                })
              }
            />
          ))}
        </div>
      )}

      {/* Schedule */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Schedule Date</label>
          <input
            type="date"
            value={draft.scheduleDate}
            onChange={(e) => onUpdate({ scheduleDate: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Schedule Time <span className="text-gray-400 font-normal">(IST)</span>
          </label>
          <TimePicker12h
            value={draft.scheduleTime}
            onChange={(scheduleTime) => onUpdate({ scheduleTime })}
            className="w-full"
          />
        </div>
      </div>
      {(() => {
        const eta = computeEta(draft.scheduleDate, draft.scheduleTime, Math.ceil(capacity.estimatedMinutes));
        return eta ? (
          <p className="text-xs text-gray-500 -mt-4 mb-6 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            With {draft.selectedNumbers.length} number{draft.selectedNumbers.length === 1 ? "" : "s"}, this should finish delivering by{" "}
            <span className="font-medium text-gray-700">{eta.time}{eta.nextDay ? " (next day)" : ""}</span>
          </p>
        ) : null;
      })()}

      {/* Auto-retry & Failure Handling */}
      <div className="mb-6 space-y-4">
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={(draft as unknown as { autoRetry?: boolean }).autoRetry !== false}
              onChange={(e) => onUpdate({ autoRetry: e.target.checked } as unknown as Partial<CampaignDraft>)}
              className="w-4 h-4 text-primary-600 rounded"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">Auto-retry failed messages</p>
              <p className="text-xs text-gray-500">Automatically reroute failed contacts to other healthy numbers after campaign completes</p>
            </div>
          </label>
        </div>

        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={(draft as unknown as { respectUnsubscribeList?: boolean }).respectUnsubscribeList !== false}
              onChange={(e) => onUpdate({ respectUnsubscribeList: e.target.checked } as unknown as Partial<CampaignDraft>)}
              className="w-4 h-4 text-primary-600 rounded"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">Skip contacts who replied STOP</p>
              <p className="text-xs text-gray-500">Uncheck to send to everyone in the list anyway, ignoring the unsubscribe list</p>
            </div>
          </label>
        </div>

        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={(draft as unknown as { excludePaidUsers?: boolean }).excludePaidUsers !== false}
              onChange={(e) => onUpdate({ excludePaidUsers: e.target.checked } as unknown as Partial<CampaignDraft>)}
              className="w-4 h-4 text-primary-600 rounded"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">Skip already-paid contacts</p>
              <p className="text-xs text-gray-500">Checks phone/email against the paid-users list — uncheck to send to them anyway</p>
            </div>
          </label>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">If a number becomes MARKETING</label>
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex items-center gap-2 p-3 border rounded-lg cursor-pointer hover:border-primary-300 flex-1">
              <input
                type="radio"
                name="failureMode"
                value="reroute"
                checked={(draft as unknown as { failureMode?: string }).failureMode !== "skip"}
                onChange={() => onUpdate({ failureMode: "reroute" } as unknown as Partial<CampaignDraft>)}
                className="w-4 h-4 text-primary-600"
              />
              <div>
                <p className="text-sm font-medium text-gray-900">Reroute</p>
                <p className="text-xs text-gray-500">Send from other healthy numbers</p>
              </div>
            </label>
            <label className="flex items-center gap-2 p-3 border rounded-lg cursor-pointer hover:border-primary-300 flex-1">
              <input
                type="radio"
                name="failureMode"
                value="skip"
                checked={(draft as unknown as { failureMode?: string }).failureMode === "skip"}
                onChange={() => onUpdate({ failureMode: "skip" } as unknown as Partial<CampaignDraft>)}
                className="w-4 h-4 text-primary-600"
              />
              <div>
                <p className="text-sm font-medium text-gray-900">Skip</p>
                <p className="text-xs text-gray-500">Don&apos;t send those contacts</p>
              </div>
            </label>
          </div>
        </div>
      </div>

      {/* Summary */}
      {draft.template && (
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-2">
            <h4 className="text-sm font-medium text-gray-900">Final message preview</h4>
            <span className="text-xs text-gray-400">
              {sampleRow
                ? `Using the first contact in your CSV${sampleRow.name ? ` (${sampleRow.name})` : ""}`
                : sampleError
                ? "Couldn't load a sample contact — showing column names"
                : "Loading sample contact…"}
            </span>
          </div>
          <div className="max-w-sm">
            <TemplatePreview
              template={draft.template}
              resolvedValues={previewValues}
              headerImageUrl={draft.headerImageUrl || undefined}
            />
          </div>
          {sampleRow && Object.values(previewValues).some((v) => v === "(empty)") && (
            <p className="text-xs text-amber-600 mt-2 flex items-start gap-1">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              One or more parameters are empty for this contact — check the mapping before scheduling.
            </p>
          )}
        </div>
      )}

      <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Business</span>
          <span className="text-gray-900 font-medium">{draft.business?.businessName}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Sending Numbers</span>
          <span className="text-gray-900 font-medium">{draft.selectedNumbers.length}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Template</span>
          <span className="text-gray-900 font-medium">{draft.template?.templateName}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Category</span>
          <span className={`font-medium ${
            draft.template?.category === "MARKETING" ? "text-red-600" :
            !isMeta && draft.template?.category === "unknown" ? "text-gray-400" : "text-green-600"
          }`}>
            {!isMeta && draft.template?.category === "unknown" ? "N/A" : draft.template?.category || "UTILITY"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Parameters</span>
          <span className="text-gray-900 font-medium">{draft.template?.parameterCount} body params{draft.headerImageUrl ? " + image header" : ""}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Total Contacts</span>
          <span className="text-gray-900 font-medium">{draft.csvRowCount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Distribution</span>
          <span className="text-gray-900 font-medium">
            ~{Math.ceil(draft.csvRowCount / (draft.selectedNumbers.length || 1))} per number
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-gray-500 flex items-center gap-1"><Clock className="w-3.5 h-3.5" />Estimated Delivery Time</span>
          <span className="text-gray-900 font-medium">{formatMinutes(capacity.estimatedMinutes)}</span>
        </div>
        <div className="border-t border-gray-200 pt-2 mt-2">
          {isMeta ? (
            <>
              <div className="flex justify-between">
                <span className="text-gray-500">Estimated Cost</span>
                <span className="text-gray-900 font-bold">
                  ₹{((draft.template?.category === "MARKETING" ? 0.8631 : 0.115) * draft.csvRowCount).toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {draft.template?.category === "MARKETING" ? "₹0.8631" : "₹0.115"}/msg × {draft.csvRowCount} contacts (charged on delivery)
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-400">
              Billed via your {provider === "aisensy" ? "AiSensy" : "WATI"} plan — Meta&apos;s per-message pricing shown above doesn&apos;t apply here.
            </p>
          )}
        </div>
      </div>

      {/* Delivery-time advisor: how many numbers would it take to hit a target time? */}
      <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-lg text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-blue-900">Want it delivered within</span>
          <input
            type="number"
            min={1}
            value={targetMinutes}
            onChange={(e) => setTargetMinutes(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-16 border border-blue-200 rounded px-2 py-1 text-sm text-center"
          />
          <span className="text-blue-900">minutes?</span>
          {capacity.numbersNeededForTarget != null && (
            <span className="text-blue-800">
              {draft.selectedNumbers.length >= capacity.numbersNeededForTarget
                ? `You have enough numbers (need ${capacity.numbersNeededForTarget}, have ${draft.selectedNumbers.length}).`
                : `You'll need ${capacity.numbersNeededForTarget} numbers (currently ${draft.selectedNumbers.length}) — add ${capacity.numbersNeededForTarget - draft.selectedNumbers.length} more.`}
            </span>
          )}
        </div>
        <p className="text-xs text-blue-700 mt-1">
          Based on a safe pace of {SAFE_MSGS_PER_SECOND}/sec per number — faster delivery only ever comes from adding numbers, never from sending any one number faster.
        </p>
      </div>

      {/* Number-health warning: does today's contact count exceed what these numbers can safely carry in 24h? */}
      {capacity.exceedsAggregateCapacity && (
        <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800">
            Your selected numbers&apos; combined safe 24-hour limit is ~{capacity.aggregateDailyCapacity.toLocaleString()} contacts,
            but this campaign is sending to {draft.csvRowCount.toLocaleString()}. Numbers without a recent quality check are assumed
            to be on the smallest tier — re-run &quot;Fetch Quality Rating&quot; on your numbers, add more numbers, or split this
            campaign across multiple days to avoid pushing any single number past its tier limit.
          </p>
        </div>
      )}

      {editCampaignId?.startsWith("currentbatch_") && (
        <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
          <TestNumbersPanel
            applyToCampaignId={editCampaignId}
            onApplied={() => onUpdate({ csvRowCount: draft.csvRowCount + 1 })}
          />
        </div>
      )}

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSendNow}
            disabled={!draft.workshop || !draft.batch || !draft.msg || scheduling}
            title="Sends within about a minute instead of waiting for a picked date/time"
            className="flex items-center gap-1.5 px-4 py-2 border border-primary-300 text-primary-700 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-50 transition-colors"
          >
            <Zap className="w-4 h-4" />
            {scheduling ? "Sending..." : "Send Now"}
          </button>
          <button
            onClick={handleSchedule}
            disabled={!draft.workshop || !draft.batch || !draft.msg || !draft.scheduleDate || !draft.scheduleTime || !extrasScheduled || scheduling}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
          >
            {scheduling ? "Scheduling..." : "Schedule Campaign"}
          </button>
        </div>
      </div>
    </div>
  );
}
