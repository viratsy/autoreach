import Sidebar from "./Sidebar";

interface Props {
  children: React.ReactNode;
  // Override for pages with their own internal scroll/layout (e.g. the chat
  // UI in conversations/page.tsx, which manages its own flex-col + overflow
  // rather than using the default padded/scrollable main). Always keep
  // `pt-20 md:pt-0` (or equivalent) in an override — that's what reserves
  // space for the mobile-only hamburger button.
  mainClassName?: string;
}

/**
 * Shared page shell — extracted from the identical `<div className="flex
 * h-screen"><Sidebar />...` markup every page used to repeat. Centralizing it
 * here is what lets the mobile hamburger/drawer (self-contained in
 * Sidebar.tsx) work everywhere without touching each page individually — the
 * `pt-20 md:p-6` reserves space for the mobile-only hamburger button.
 */
export default function AppShell({ children, mainClassName }: Props) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className={mainClassName || "flex-1 overflow-y-auto p-4 pt-20 md:p-6"}>{children}</main>
    </div>
  );
}
