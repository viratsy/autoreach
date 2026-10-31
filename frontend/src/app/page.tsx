"use client";

import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import Dashboard from "@/components/dashboard/Dashboard";

export default function Home() {
  return (
    <AuthGuard>
      <AppShell>
          <Dashboard />
      </AppShell>
    </AuthGuard>
  );
}
