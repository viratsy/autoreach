"use client";

import { Bell } from "lucide-react";
import { getCurrentEmail } from "@/lib/api";

interface Props {
  unreadCount: number;
}

/** Title-cases the local-part of the logged-in email for a real (not
 * fabricated) greeting name — e.g. "virat.sharma@x.com" → "Virat.sharma". No
 * display-name field exists anywhere in the data model, so this is the only
 * honest source for a "Welcome back" name. */
function nameFromEmail(email: string | null): string {
  if (!email) return "there";
  const local = email.split("@")[0] || "there";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export default function DashboardHeader({ unreadCount }: Props) {
  const name = nameFromEmail(getCurrentEmail());

  return (
    <div className="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Welcome back, {name} 👋</h2>
        <p className="text-gray-500 text-sm mt-1">Here&apos;s what&apos;s happening with your campaigns.</p>
      </div>
      <div className="relative">
        <div className="p-2 rounded-lg border border-gray-200 bg-white text-gray-500">
          <Bell className="w-5 h-5" />
        </div>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </div>
    </div>
  );
}
