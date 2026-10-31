"use client";

import { FileText } from "lucide-react";
import { TopTemplateStat } from "@/types";

interface Props {
  templates?: TopTemplateStat[];
}

export default function TopTemplatesCard({ templates }: Props) {
  const items = templates || [];

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Top Performing Templates</h3>
        <a href="/templates/" className="text-xs text-primary-600 hover:text-primary-700 font-medium">
          View all
        </a>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">No campaigns in this period yet.</p>
      ) : (
        <div className="space-y-3">
          {items.map((t, i) => (
            <div key={t.templateName} className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-500 shrink-0">
                {i + 1}
              </div>
              <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
                <FileText className="w-4 h-4 text-primary-600" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{t.templateName}</p>
                <p className="text-xs text-gray-400">
                  Used {t.campaignCount} campaign{t.campaignCount !== 1 ? "s" : ""} · {t.totalContacts.toLocaleString()} contacts
                </p>
              </div>
              <p className="text-sm font-semibold text-emerald-600 shrink-0">{(t.deliveryRate * 100).toFixed(1)}%</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
