"use client";

import { useRef, useState, useEffect } from "react";
import { CampaignDraft } from "@/app/campaigns/new/page";
import { apiRequest } from "@/lib/api";
import { Upload, CheckCircle, FolderOpen } from "lucide-react";

interface Props {
  draft: CampaignDraft;
  onUpdate: (updates: Partial<CampaignDraft>) => void;
  onNext: () => void;
  onBack: () => void;
}

interface S3File {
  s3Key: string;
  fileName: string;
  size: number;
  uploadedAt: string;
}

interface ValidationError {
  row: number;
  phone: string;
  reason: string;
}

export default function UploadCSV({ draft, onUpdate, onNext, onBack }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"upload" | "existing">("upload");
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [existingFiles, setExistingFiles] = useState<S3File[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    if (mode === "existing") loadExistingFiles();
  }, [mode]);

  const loadExistingFiles = async () => {
    setLoadingFiles(true);
    try {
      const data = await apiRequest<{ files: S3File[] }>("/campaigns/files");
      setExistingFiles(data.files);
    } catch {
    } finally {
      setLoadingFiles(false);
    }
  };

  const selectExistingFile = async (file: S3File) => {
    setLoadingPreview(true);
    setErrors([]);
    try {
      const data = await apiRequest<{ headers: string[]; totalRows: number; preview: Record<string, string>[] }>(
        `/campaigns/file-preview?s3Key=${encodeURIComponent(file.s3Key)}`
      );

      if (!data.headers.includes("phone")) {
        setErrors([{ row: 0, phone: "", reason: "CSV must contain a 'phone' column" }]);
        return;
      }

      setPreview(data.preview);
      onUpdate({
        csvFile: null,
        csvHeaders: data.headers,
        csvRowCount: data.totalRows,
        csvS3Key: file.s3Key,
      });
      setUploaded(true);
    } catch {
      setErrors([{ row: 0, phone: "", reason: "Failed to read file" }]);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploaded(false);
    setErrors([]);
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

  const handleUpload = async () => {
    if (!draft.csvFile) return;
    setUploading(true);
    try {
      const { uploadUrl, s3Key } = await apiRequest<{ uploadUrl: string; s3Key: string }>(
        "/campaigns/upload-url",
        { method: "POST", body: JSON.stringify({ fileName: draft.csvFile.name }) }
      );
      await fetch(uploadUrl, { method: "PUT", body: draft.csvFile, headers: { "Content-Type": "text/csv" } });
      onUpdate({ csvS3Key: s3Key });
      setUploaded(true);
    } catch {
      setErrors([{ row: 0, phone: "", reason: "Upload failed. Please try again." }]);
    } finally {
      setUploading(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Upload CSV</h3>

      {/* Mode toggle */}
      <div className="flex bg-gray-100 rounded-lg p-1 mb-5">
        <button
          onClick={() => { setMode("upload"); setUploaded(false); setPreview([]); setErrors([]); }}
          className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${
            mode === "upload" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
          }`}
        >
          <Upload className="w-4 h-4" />
          Upload New
        </button>
        <button
          onClick={() => { setMode("existing"); setUploaded(false); setPreview([]); setErrors([]); }}
          className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${
            mode === "existing" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
          }`}
        >
          <FolderOpen className="w-4 h-4" />
          Use Existing
        </button>
      </div>

      {mode === "upload" ? (
        <>
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

          {draft.csvFile && !uploaded && errors.length === 0 && (
            <div className="mt-4">
              <p className="text-sm text-gray-600 mb-2">
                {draft.csvRowCount} contacts • {draft.csvHeaders.length} columns
              </p>
              <button
                onClick={handleUpload}
                disabled={uploading}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
              >
                {uploading ? "Uploading..." : "Upload to Server"}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {loadingFiles ? (
            <p className="text-gray-500 text-sm py-4">Loading files...</p>
          ) : existingFiles.length === 0 ? (
            <p className="text-gray-500 text-sm py-4">No files found. Upload a CSV first or add files directly to S3.</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {existingFiles.map((file) => (
                <button
                  key={file.s3Key}
                  onClick={() => selectExistingFile(file)}
                  disabled={loadingPreview}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    draft.csvS3Key === file.s3Key
                      ? "border-primary-500 bg-primary-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <p className="text-sm font-medium text-gray-900">{file.fileName}</p>
                  <p className="text-xs text-gray-500">
                    {formatSize(file.size)} • {new Date(file.uploadedAt).toLocaleString()}
                  </p>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {uploaded && (
        <div className="mt-4 flex items-center gap-2 text-green-600">
          <CheckCircle className="w-4 h-4" />
          <p className="text-sm font-medium">
            {draft.csvRowCount} contacts • {draft.csvHeaders.length} columns
          </p>
        </div>
      )}

      {errors.length > 0 && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm font-medium text-red-700 mb-1">
            {errors.length} validation error{errors.length !== 1 ? "s" : ""}
          </p>
          <ul className="text-xs text-red-600 space-y-1">
            {errors.slice(0, 5).map((err, i) => (
              <li key={i}>Row {err.row}: {err.reason} {err.phone && `(${err.phone})`}</li>
            ))}
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
          disabled={!uploaded}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
