"use client";

import { useEffect, useState } from "react";
import { Image as ImageIcon, FileText, Video, ExternalLink, Phone, CornerDownRight } from "lucide-react";
import { Template } from "@/types";

interface Props {
  template: Pick<Template, "components"> | null;
  // Already-resolved display value per param index ("1", "2", ...) — same
  // values the parameter-mapping form computes, just handed over as a map
  // instead of a single pre-joined string so this component can substitute
  // them into the body itself.
  resolvedValues: Record<string, string>;
  headerImageUrl?: string;
}

/**
 * Simulates what the CUSTOMER's phone shows when this template is sent —
 * left-aligned white bubble, not the business's own outbound-chat style used
 * in conversations/page.tsx (that one's for the live-chat inbox, a different
 * context: our agent's own sent replies, not an outgoing template).
 *
 * Deliberately renders body/footer/button text as plain React text nodes only
 * (no dangerouslySetInnerHTML) — no WhatsApp bold/italic markdown parsing for
 * v1, since that's not worth introducing an injection surface for on a
 * cosmetic nicety.
 */
export default function TemplatePreview({ template, resolvedValues, headerImageUrl }: Props) {
  // Computed client-side only, after mount — Date formatting (AM/PM casing,
  // locale) can differ between the server render and the browser, which
  // would otherwise cause a hydration mismatch. Starts empty so the very
  // first client render matches the server's empty string exactly.
  const [timestamp, setTimestamp] = useState("");
  useEffect(() => {
    setTimestamp(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  }, []);

  if (!template) {
    return (
      <div className="bg-gray-100 rounded-2xl p-6 flex items-center justify-center min-h-[200px]">
        <p className="text-xs text-gray-400 text-center">Select a template to preview it here</p>
      </div>
    );
  }

  const components = template.components || [];
  const header = components.find((c) => (c.type as string).toUpperCase() === "HEADER");
  const body = components.find((c) => (c.type as string).toUpperCase() === "BODY");
  const footer = components.find((c) => (c.type as string).toUpperCase() === "FOOTER");
  const buttonsComponent = components.find((c) => (c.type as string).toUpperCase() === "BUTTONS");
  const buttons = buttonsComponent?.buttons || [];

  const bodyText = (body?.text || "").replace(/\{\{(\d+)\}\}/g, (_match, n: string) => resolvedValues[n] || "___");

  const headerFormat = (header?.format || "TEXT").toUpperCase();

  return (
    <div className="bg-[#e5ddd5] rounded-2xl p-4 flex justify-center">
      <div className="w-full max-w-[280px]">
        <div className="bg-white rounded-2xl rounded-bl-md shadow-sm border border-gray-100 overflow-hidden">
          {header && headerFormat === "TEXT" && header.text && (
            <p className="px-3 pt-3 text-sm font-semibold text-gray-900 break-words">{header.text}</p>
          )}
          {header && headerFormat === "IMAGE" && (
            headerImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={headerImageUrl} alt="Header" className="w-full h-36 object-cover" />
            ) : (
              <div className="w-full h-36 bg-gray-200 flex items-center justify-center">
                <ImageIcon className="w-8 h-8 text-gray-400" />
              </div>
            )
          )}
          {header && (headerFormat === "VIDEO" || headerFormat === "DOCUMENT") && (
            <div className="w-full h-16 bg-gray-100 flex items-center gap-2 px-3">
              {headerFormat === "VIDEO" ? (
                <Video className="w-5 h-5 text-gray-400" />
              ) : (
                <FileText className="w-5 h-5 text-gray-400" />
              )}
              <span className="text-xs text-gray-400">
                {headerFormat === "VIDEO" ? "Video attachment" : "Document attachment"}
              </span>
            </div>
          )}

          <div className="px-3 py-2">
            {bodyText ? (
              <p className="text-sm text-gray-800 whitespace-pre-wrap break-words leading-relaxed">{bodyText}</p>
            ) : (
              <p className="text-sm text-gray-300 italic">No body text</p>
            )}
            {footer?.text && <p className="text-xs text-gray-400 mt-1 break-words">{footer.text}</p>}
            <p className="text-[10px] text-gray-400 text-right mt-1">{timestamp}</p>
          </div>
        </div>

        {buttons.length > 0 && (
          <div className="bg-white rounded-2xl mt-0.5 shadow-sm border border-gray-100 divide-y divide-gray-100 overflow-hidden">
            {buttons.map((btn, i) => (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-2.5 text-sm text-blue-600 font-medium"
              >
                {btn.type === "URL" ? (
                  <ExternalLink className="w-3.5 h-3.5" />
                ) : btn.type === "PHONE_NUMBER" ? (
                  <Phone className="w-3.5 h-3.5" />
                ) : (
                  <CornerDownRight className="w-3.5 h-3.5" />
                )}
                {btn.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
