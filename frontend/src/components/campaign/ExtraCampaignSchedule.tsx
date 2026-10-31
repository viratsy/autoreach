"use client";

import { ExtraCampaign } from "@/app/campaigns/new/page";
import TimePicker12h from "./TimePicker12h";
import EmailChannelPanel from "./EmailChannelPanel";

/**
 * Send time, name and email choice for one additional campaign.
 *
 * Each campaign gets its own date and time rather than an offset from a shared
 * base — the templates being scheduled together are usually time-variant ones
 * (11:10, 11:20, 11:30) whose times are deliberate rather than evenly spaced.
 */
export default function ExtraCampaignSchedule({
  extra,
  workshop,
  batch,
  defaultDate,
  csvS3Key,
  contactCount,
  onChange,
}: {
  extra: ExtraCampaign;
  workshop: string;
  batch: string;
  /** The primary campaign's date, used so same-day sends need no retyping. */
  defaultDate: string;
  /** Shared with the primary campaign — extras never upload their own. */
  csvS3Key: string;
  contactCount: number;
  onChange: (updates: Partial<ExtraCampaign>) => void;
}) {
  const label = extra.msg || extra.template.templateName;
  const date = extra.scheduleDate || defaultDate;
  const ready = Boolean(date && extra.scheduleTime);

  return (
    <div className="border border-gray-200 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{extra.template.templateName}</p>
          <p className="text-xs text-gray-400 truncate">
            {[workshop, batch, label].filter(Boolean).join("_") || "workshop_batch_msg"}_xxxxxx
          </p>
        </div>
        <span
          className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${
            ready ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
          }`}
        >
          {ready ? "scheduled" : "needs a time"}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Message</label>
          <input
            value={extra.msg}
            onChange={(e) => onChange({ msg: e.target.value })}
            placeholder={extra.template.templateName}
            className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => onChange({ scheduleDate: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Time (IST)</label>
          <TimePicker12h
            value={extra.scheduleTime}
            onChange={(scheduleTime) => onChange({ scheduleTime })}
          />
        </div>
      </div>

      {/* No campaignId — this campaign does not exist yet. The CSV key is
          enough for a test, since every extra shares the primary's audience. */}
      <EmailChannelPanel
        msg={label}
        enabled={extra.emailEnabled}
        onChange={(emailEnabled) => onChange({ emailEnabled })}
        templateId={extra.emailTemplateId}
        onTemplateChange={(emailTemplateId) => onChange({ emailTemplateId })}
        csvS3Key={csvS3Key}
        contactCount={contactCount}
      />
    </div>
  );
}
