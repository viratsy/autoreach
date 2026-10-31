"use client";

import { AlertTriangle } from "lucide-react";
import Modal from "./Modal";

export interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

interface Props {
  state: ConfirmDialogState | null;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ state, loading, onConfirm, onCancel }: Props) {
  if (!state) return null;
  const { title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger } = state;

  return (
    <Modal open={!!state} onClose={loading ? undefined : onCancel} title={title}>
      <div className="flex gap-3">
        {danger && (
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-red-100 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-600" />
          </div>
        )}
        <p className="text-sm text-gray-600 whitespace-pre-line">{message}</p>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button
          onClick={onCancel}
          disabled={loading}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className={`px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 ${
            danger ? "bg-red-600 hover:bg-red-700" : "bg-primary-600 hover:bg-primary-700"
          }`}
        >
          {loading ? "Working..." : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
