"use client";

import { useRef, useState } from "react";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { Upload } from "lucide-react";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

interface ValidationError {
  row: number;
  phone: string;
  reason: string;
}

export default function UploadCSV({ draft, onUpdate, onNext, onBack }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.trim().split("\n");
      const headers = lines[0].split(",").map((h) => h.trim());

      if (!headers.includes("phone")) {
        setErrors([{ row: 0, phone: "", reason: "CSV must contain a 'phone' column" }]);
        return;
      }

      const rows = lines.slice(1).map((line) => {
        const values = line.split(",").map((v) => v.trim());
        const row: Record<string, string> = {};
        headers.forEach((h, i) => (row[h] = values[i] || ""));
        return row;
      });

      // Validate phone numbers
      const validationErrors: ValidationError[] = [];
      rows.forEach((row, i) => {
        const phone = row.phone;
        if (!phone || !/^\d{10,15}$/.test(phone.replace(/\D/g, ""))) {
          validationErrors.push({ row: i + 2, phone, reason: "Invalid phone number" });
        }
      });

      setErrors(validationErrors);
      setPreview(rows.slice(0, 10));
      onUpdate({
        csvFile: file,
        csvHeaders: headers,
        csvRowCount: rows.length,
      });
    };
    reader.readAsText(file);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Upload CSV</h3>

      <div
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-primary-400 transition-colors"
      >
        <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
        <p className="text-sm text-gray-600">
          {draft.csvFile ? draft.csvFile.name : "Click to upload CSV file"}
        </p>
        <p className="text-xs text-gray-400 mt-1">Must contain a &quot;phone&quot; column</p>
        <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
      </div>

      {draft.csvFile && (
        <p className="mt-3 text-sm text-gray-600">
          {draft.csvRowCount} contacts found • {draft.csvHeaders.length} columns
        </p>
      )}

      {errors.length > 0 && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm font-medium text-red-700 mb-1">
            {errors.length} validation error{errors.length !== 1 ? "s" : ""}
          </p>
          <ul className="text-xs text-red-600 space-y-1 max-h-32 overflow-y-auto">
            {errors.slice(0, 5).map((err, i) => (
              <li key={i}>Row {err.row}: {err.reason} ({err.phone})</li>
            ))}
            {errors.length > 5 && <li>...and {errors.length - 5} more</li>}
          </ul>
        </div>
      )}

      {preview.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <p className="text-sm font-medium text-gray-700 mb-2">Preview (first 10 rows)</p>
          <table className="w-full text-xs border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr>
                {draft.csvHeaders.map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {preview.map((row, i) => (
                <tr key={i}>
                  {draft.csvHeaders.map((h) => (
                    <td key={h} className="px-3 py-2 text-gray-700">{row[h]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!draft.csvFile || errors.length > 0}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
