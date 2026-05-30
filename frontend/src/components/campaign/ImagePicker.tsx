"use client";

import { useRef, useState, useEffect } from "react";
import { apiRequest } from "@/lib/api";
import { Upload, Image as ImageIcon, Check } from "lucide-react";

interface Props {
  value: string;
  onChange: (url: string) => void;
}

interface ImageFile {
  s3Key: string;
  fileName: string;
  cdnUrl: string;
  size: number;
  uploadedAt: string;
}

/**
 * Compress image client-side using Canvas.
 * Resizes to maxWidth and converts to JPEG with given quality.
 */
async function compressImage(file: File, maxWidth: number, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = (height * maxWidth) / width;
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Compression failed"));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export default function ImagePicker({ value, onChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"upload" | "gallery" | "url">(value ? "url" : "gallery");
  const [images, setImages] = useState<ImageFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [lastKey, setLastKey] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "gallery") loadImages();
  }, [mode]);

  const loadImages = async (startAfter?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "10" });
      if (startAfter) params.set("startAfter", startAfter);
      const data = await apiRequest<{ images: ImageFile[]; hasMore: boolean; lastKey: string | null }>(
        `/campaigns/images?${params}`
      );
      if (startAfter) {
        setImages((prev) => [...prev, ...data.images]);
      } else {
        setImages(data.images);
      }
      setHasMore(data.hasMore);
      setLastKey(data.lastKey);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      // Compress image client-side before upload
      const compressed = await compressImage(file, 800, 0.75);

      const { uploadUrl, cdnUrl } = await apiRequest<{ uploadUrl: string; cdnUrl: string }>(
        "/campaigns/upload-image",
        {
          method: "POST",
          body: JSON.stringify({ fileName: file.name.replace(/\.[^.]+$/, ".jpg"), contentType: "image/jpeg" }),
        }
      );

      await fetch(uploadUrl, {
        method: "PUT",
        body: compressed,
        headers: { "Content-Type": "image/jpeg" },
      });

      onChange(cdnUrl);
      setMode("url");
    } catch (err) {
      console.error("Image upload failed:", err);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      {/* Mode tabs */}
      <div className="flex bg-white rounded-md border border-blue-200 p-0.5 mb-3">
        <button
          onClick={() => setMode("upload")}
          className={`flex-1 py-1.5 text-xs rounded ${mode === "upload" ? "bg-blue-100 text-blue-800 font-medium" : "text-gray-500"}`}
        >
          Upload New
        </button>
        <button
          onClick={() => setMode("gallery")}
          className={`flex-1 py-1.5 text-xs rounded ${mode === "gallery" ? "bg-blue-100 text-blue-800 font-medium" : "text-gray-500"}`}
        >
          Gallery
        </button>
        <button
          onClick={() => setMode("url")}
          className={`flex-1 py-1.5 text-xs rounded ${mode === "url" ? "bg-blue-100 text-blue-800 font-medium" : "text-gray-500"}`}
        >
          Paste URL
        </button>
      </div>

      {mode === "upload" && (
        <div
          onClick={() => fileRef.current?.click()}
          className="border-2 border-dashed border-blue-300 rounded-lg p-4 text-center cursor-pointer hover:border-blue-400 transition-colors"
        >
          <Upload className="w-6 h-6 text-blue-400 mx-auto mb-1" />
          <p className="text-xs text-blue-600">
            {uploading ? "Uploading..." : "Click to upload image (JPG, PNG, WebP)"}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleUpload}
            className="hidden"
          />
        </div>
      )}

      {mode === "gallery" && (
        <div>
          {loading && images.length === 0 ? (
            <p className="text-xs text-gray-500 py-2">Loading images...</p>
          ) : images.length === 0 ? (
            <p className="text-xs text-gray-500 py-2">No images uploaded yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2 max-h-40 overflow-y-auto">
                {images.map((img) => (
                  <button
                    key={img.s3Key}
                    onClick={() => { onChange(img.cdnUrl); setMode("url"); }}
                    className={`relative rounded-lg overflow-hidden border-2 aspect-square ${
                      value === img.cdnUrl ? "border-blue-500" : "border-gray-200 hover:border-blue-300"
                    }`}
                  >
                    <img src={img.cdnUrl} alt={img.fileName} className="w-full h-full object-cover" />
                    {value === img.cdnUrl && (
                      <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center">
                        <Check className="w-5 h-5 text-blue-700" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
              {hasMore && (
                <button
                  onClick={() => loadImages(lastKey || undefined)}
                  disabled={loading}
                  className="mt-2 text-xs text-blue-600 hover:text-blue-700"
                >
                  {loading ? "Loading..." : "Load More"}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {mode === "url" && (
        <div>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://example.com/image.jpg"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          {value && (
            <div className="mt-2 flex items-center gap-2">
              <img src={value} alt="Preview" className="w-16 h-16 object-cover rounded border" />
              <p className="text-xs text-green-600 flex items-center gap-1">
                <Check className="w-3 h-3" /> Image selected
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
