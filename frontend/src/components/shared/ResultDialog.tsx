"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import Modal from "./Modal";

export interface ResultDialogState {
  title: string;
  summary: string;
  items?: { label: string; reason: string }[];
}

interface Props {
  state: ResultDialogState | null;
  onClose: () => void;
}

export default function ResultDialog({ state, onClose }: Props) {
  if (!state) return null;
  const items = state.items || [];

  return (
    <Modal open={!!state} onClose={onClose} title={state.title} maxWidth="max-w-lg">
      <div className="flex items-start gap-3 mb-4">
        {items.length === 0 ? (
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
        ) : (
          <XCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
        )}
        <p className="text-sm text-gray-700 font-medium whitespace-pre-line">{state.summary}</p>
      </div>
      {items.length > 0 && (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-y-auto">
          {items.map((it, i) => (
            <div key={i} className="px-3 py-2 text-xs">
              <div className="font-mono text-gray-700 truncate">{it.label}</div>
              <div className="text-red-600">{it.reason}</div>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end mt-5">
        <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700">
          Done
        </button>
      </div>
    </Modal>
  );
}
