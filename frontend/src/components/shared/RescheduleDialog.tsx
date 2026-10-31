"use client";

import { useState } from "react";
import Modal from "./Modal";

interface Props {
  open: boolean;
  campaignName: string;
  initialDate: string;
  initialTime: string;
  loading: boolean;
  onCancel: () => void;
  onSave: (date: string, time: string) => void;
}

export default function RescheduleDialog({ open, campaignName, initialDate, initialTime, loading, onCancel, onSave }: Props) {
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  if (!open) return null;

  return (
    <Modal open={open} onClose={loading ? undefined : onCancel} title="Reschedule campaign">
      <p className="text-xs text-gray-500 mb-4 truncate">{campaignName}</p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">New date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">New time (IST)</label>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button
          onClick={onCancel}
          disabled={loading}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => date && time && onSave(date, time)}
          disabled={loading || !date || !time}
          className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
        >
          {loading ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}
