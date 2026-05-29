"use client";

import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Send,
  Building2,
  PlusCircle,
  LogOut,
} from "lucide-react";
import { logout, getCurrentEmail } from "@/lib/api";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/campaigns/", label: "Campaigns", icon: Send },
  { href: "/campaigns/new/", label: "New Campaign", icon: PlusCircle },
  { href: "/businesses/", label: "Businesses", icon: Building2 },
];

export default function Sidebar() {
  const pathname = usePathname() || "/";
  const email = getCurrentEmail();

  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
      <div className="p-6 border-b border-gray-200">
        <h1 className="text-xl font-bold text-primary-700">AutoReach</h1>
        <p className="text-xs text-gray-500 mt-1">WhatsApp Campaign Scheduler</p>
      </div>
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname === item.href + "/";
          return (
            <a
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-primary-50 text-primary-700 font-medium"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </a>
          );
        })}
      </nav>
      <div className="p-4 border-t border-gray-200">
        <p className="text-xs text-gray-500 truncate mb-2">{email}</p>
        <button
          onClick={logout}
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-red-600 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Logout
        </button>
      </div>
    </aside>
  );
}
