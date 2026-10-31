"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Send,
  Building2,
  PlusCircle,
  LogOut,
  FileText,
  CalendarClock,
  Workflow,
  MessageSquare,
  Zap,
  IndianRupee,
  Wallet,
  Menu,
  X,
  Repeat,
  History,
  Cloud,
  PanelLeftClose,
  PanelLeftOpen,
  MailPlus,
} from "lucide-react";
import { logout, getCurrentEmail } from "@/lib/api";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/campaigns/", label: "Campaigns", icon: Send },
  { href: "/campaigns/new/", label: "New Campaign", icon: PlusCircle },
  { href: "/quick-send/", label: "Quick Send", icon: Zap },
  { href: "/crossale/", label: "Crossale", icon: Repeat },
  { href: "/costs/", label: "Total Cost", icon: IndianRupee },
  { href: "/whatsapp-spend/", label: "WhatsApp Spend", icon: Wallet },
  { href: "/aws-billing/", label: "AWS Billing", icon: Cloud },
  { href: "/flows/", label: "Flows", icon: Workflow },
  { href: "/conversations/", label: "Conversations", icon: MessageSquare },
  { href: "/contact-timeline/", label: "Contact Timeline", icon: History },
  { href: "/workshops/registry/", label: "WS Registry", icon: CalendarClock },
  { href: "/workshops/config/", label: "WS Config", icon: CalendarClock },
  { href: "/workshops/params/", label: "WS Params", icon: CalendarClock },
  { href: "/templates/", label: "Templates", icon: FileText },
  { href: "/email-templates/", label: "Email Templates", icon: MailPlus },
  { href: "/businesses/", label: "Businesses", icon: Building2 },
];

const COLLAPSE_KEY = "autoreach_sidebar_collapsed";

export default function Sidebar() {
  const pathname = usePathname() || "/";
  const email = getCurrentEmail();
  // Collapsed by default: the nav is 16rem of a window that often isn't much
  // wider than the campaigns table needs, and the table is what people are
  // actually here to read. The choice persists per browser.
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(COLLAPSE_KEY);
      if (saved !== null) setCollapsed(saved === "1");
    } catch {
      // Private windows and blocked site data throw on access — the default stands.
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* preference just won't persist */
      }
      return next;
    });
  };
  // Mobile-only drawer state — the sidebar is always visible on md+ screens
  // regardless of this (see the md: overrides below), so this only matters
  // below the md breakpoint.
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile-only hamburger — fixed so it doesn't need every page to
          reserve layout space beyond AppShell's pt-20/pt-14 top padding. */}
      <button
        onClick={() => setOpen(true)}
        className="md:hidden fixed top-4 left-4 z-50 bg-white border border-gray-200 rounded-lg p-2 shadow-sm"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5 text-gray-700" />
      </button>

      {/* Backdrop — dismisses the drawer, mobile-only */}
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/40 z-30"
          onClick={() => setOpen(false)}
        />
      )}

      <aside
        className={`w-64 bg-white border-r border-gray-200 flex flex-col fixed inset-y-0 left-0 z-40 transform transition-all duration-200 ease-in-out ${
          open ? "translate-x-0" : "-translate-x-full"
        } md:translate-x-0 md:static md:z-auto ${collapsed ? "md:w-16" : "md:w-64"}`}
      >
        <div className={`border-b border-gray-200 flex items-center justify-between ${collapsed ? "md:p-3 md:justify-center p-6" : "p-6"}`}>
          <div className={collapsed ? "md:hidden" : ""}>
            <h1 className="text-xl font-bold text-primary-700">AutoReach</h1>
            <p className="text-xs text-gray-500 mt-1">WhatsApp Campaign Scheduler</p>
          </div>
          <button onClick={() => setOpen(false)} className="md:hidden text-gray-400 hover:text-gray-600" aria-label="Close menu">
            <X className="w-5 h-5" />
          </button>
          <button
            onClick={toggleCollapsed}
            className="hidden md:block text-gray-400 hover:text-gray-700 shrink-0"
            aria-label={collapsed ? "Expand menu" : "Collapse menu"}
            title={collapsed ? "Expand menu" : "Collapse menu"}
          >
            {collapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </button>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = pathname === item.href || pathname === item.href + "/";
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                title={item.label}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  collapsed ? "md:justify-center md:px-2" : ""
                } ${
                  isActive
                    ? "bg-primary-50 text-primary-700 font-medium"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                <item.icon className="w-5 h-5 shrink-0" />
                <span className={collapsed ? "md:hidden" : ""}>{item.label}</span>
              </a>
            );
          })}
        </nav>
        <div className={`border-t border-gray-200 ${collapsed ? "md:p-2 p-4" : "p-4"}`}>
          <p className={`text-xs text-gray-500 truncate mb-2 ${collapsed ? "md:hidden" : ""}`}>{email}</p>
          <button
            onClick={logout}
            title="Logout"
            className={`flex items-center gap-2 text-sm text-gray-600 hover:text-red-600 transition-colors ${
              collapsed ? "md:justify-center md:w-full" : ""
            }`}
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span className={collapsed ? "md:hidden" : ""}>Logout</span>
          </button>
        </div>
      </aside>
    </>
  );
}
