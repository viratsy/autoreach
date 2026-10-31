"use client";

import { CheckCircle2, XCircle, Phone, Gauge } from "lucide-react";
import { Business } from "@/types";

interface Props {
  businesses: Business[];
}

/** Reuses each business's cached qualityRating (from the last quality-check
 * run, GET /businesses) rather than firing a new live check — this card is
 * meant to be a glance-summary, not a fresh probe. */
export default function ApiStatusCard({ businesses }: Props) {
  const connected = businesses.filter((b) => b.hasAccessToken).length;
  const totalNumbers = businesses.reduce((sum, b) => sum + b.phoneNumbers.length, 0);

  const ratingCounts = { GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 };
  for (const b of businesses) {
    for (const pn of b.phoneNumbers) {
      const r = (pn.qualityRating as "GREEN" | "YELLOW" | "RED" | undefined) || "UNKNOWN";
      ratingCounts[r] = (ratingCounts[r] || 0) + 1;
    }
  }
  const overallRating = ratingCounts.RED > 0 ? "RED" : ratingCounts.YELLOW > 0 ? "YELLOW" : ratingCounts.GREEN > 0 ? "GREEN" : "UNKNOWN";
  const ratingLabel = { GREEN: "High Quality", YELLOW: "Medium Quality", RED: "Low Quality", UNKNOWN: "Not checked yet" }[overallRating];
  const ratingColor = { GREEN: "text-emerald-600", YELLOW: "text-amber-600", RED: "text-red-600", UNKNOWN: "text-gray-400" }[overallRating];

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Connection Status</h3>
        <span className="text-xs text-emerald-600 font-medium">
          {connected === businesses.length && businesses.length > 0 ? "All Systems Operational" : ""}
        </span>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-700">
            {connected > 0 ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            ) : (
              <XCircle className="w-4 h-4 text-red-500" />
            )}
            WhatsApp API
          </div>
          <span className="text-xs text-gray-500">
            {connected}/{businesses.length} businesses connected
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-700">
            <Phone className="w-4 h-4 text-gray-400" />
            Phone Numbers
          </div>
          <span className="text-xs text-gray-500">{totalNumbers} connected</span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-700">
            <Gauge className="w-4 h-4 text-gray-400" />
            Quality Rating
          </div>
          <span className={`text-xs font-medium ${ratingColor}`}>{ratingLabel}</span>
        </div>
      </div>
    </div>
  );
}
