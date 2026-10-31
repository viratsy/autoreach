"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export interface RowAction {
  label: string;
  /** Rendered as a link when set, otherwise a button. */
  href?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * The "…" overflow menu on a table row.
 *
 * Positioned `fixed` from the trigger's own rect rather than absolutely inside
 * the cell: the campaigns table scrolls horizontally, and `overflow-x-auto`
 * clips absolutely-positioned children, so an in-flow dropdown would be cut off
 * exactly when the table is wide enough to need one.
 */
export default function RowActionsMenu({ actions }: { actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Any scroll moves the trigger out from under a fixed menu, so close
    // rather than let it float somewhere meaningless.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Flip above the trigger when there isn't room below.
      const estimatedHeight = actions.length * 34 + 12;
      const below = window.innerHeight - rect.bottom;
      setPos({
        top: below < estimatedHeight ? rect.top - estimatedHeight : rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setOpen(true);
  };

  const enabled = actions.filter((a) => !a.disabled);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-800"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {open && pos && (
        <>
          {/* Catches the outside click. Transparent, but above the table so a
              click anywhere dismisses instead of hitting another row. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            style={{ top: pos.top, right: pos.right }}
            className="fixed z-50 min-w-[9rem] bg-white border border-gray-200 rounded-lg shadow-lg py-1"
          >
            {enabled.map((action) =>
              action.href ? (
                <a
                  key={action.label}
                  href={action.href}
                  role="menuitem"
                  className="block px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  {action.label}
                </a>
              ) : (
                <button
                  key={action.label}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    action.onClick?.();
                  }}
                  className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 ${
                    action.danger ? "text-red-600" : "text-gray-700"
                  }`}
                >
                  {action.label}
                </button>
              )
            )}
          </div>
        </>
      )}
    </>
  );
}
