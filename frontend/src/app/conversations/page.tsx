"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/layout/AuthGuard";
import TemplatePreview from "@/components/campaign/TemplatePreview";
import { apiRequest } from "@/lib/api";
import { ConversationContact, ConversationMessage } from "@/types/flows";
import { Business, TemplateComponent } from "@/types";
import {
  Search,
  Phone,
  Building2,
  RefreshCw,
  Send,
  MessageSquare,
  Clock,
  CircleDot,
} from "lucide-react";

const AVATAR_COLORS = [
  "bg-primary-100 text-primary-700",
  "bg-blue-100 text-blue-700",
  "bg-purple-100 text-purple-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initialsOf(name: string | undefined, phone: string): string {
  if (name?.trim()) {
    const parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
  }
  return phone.slice(-2);
}

function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export default function ConversationsPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusiness, setSelectedBusiness] = useState("");
  const [selectedNumber, setSelectedNumber] = useState("");
  const [contacts, setContacts] = useState<ConversationContact[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPhone, setSelectedPhone] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templates, setTemplates] = useState<{ templateName: string; parameterCount: number; components?: TemplateComponent[] }[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateParams, setTemplateParams] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const selectedContact = contacts.find((c) => c.phone === selectedPhone);
  const isWithin24hWindow = selectedContact
    ? Date.now() - new Date(selectedContact.lastTimestamp).getTime() < 24 * 60 * 60 * 1000
    : false;

  // Search matches contact name (if one is on file) or phone number, digits-only
  // so formatting like "+91 99999" or spaces/dashes in the query still matches.
  const filteredContacts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const queryDigits = searchQuery.replace(/\D/g, "");
    if (!query) return contacts;
    return contacts.filter((c) => {
      const nameMatch = c.name?.toLowerCase().includes(query);
      const phoneMatch = queryDigits.length > 0 && c.phone.includes(queryDigits);
      return nameMatch || phoneMatch;
    });
  }, [contacts, searchQuery]);

  useEffect(() => {
    loadBusinesses();
  }, []);

  useEffect(() => {
    if (selectedNumber) loadContacts();
    if (selectedNumber && selectedBusiness) loadTemplates();
  }, [selectedNumber]);

  useEffect(() => {
    if (selectedPhone && selectedNumber) loadMessages();
  }, [selectedPhone, selectedNumber]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadBusinesses() {
    try {
      const data = await apiRequest<{ businesses: Business[] }>("/businesses");
      setBusinesses(data.businesses);
      if (data.businesses.length > 0) {
        setSelectedBusiness(data.businesses[0].businessId);
        if (data.businesses[0].phoneNumbers.length > 0) {
          setSelectedNumber(data.businesses[0].phoneNumbers[0].phoneNumberId);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function loadTemplates() {
    setLoadingTemplates(true);
    try {
      const data = await apiRequest<{ templates: { templateName: string; parameterCount: number; components?: TemplateComponent[] }[] }>(
        `/templates?businessId=${selectedBusiness}&phoneNumberIds=${selectedNumber}`
      );
      const unique = data.templates.reduce((acc, t) => {
        if (!acc.find((x) => x.templateName === t.templateName)) acc.push(t);
        return acc;
      }, [] as { templateName: string; parameterCount: number; components?: TemplateComponent[] }[]);
      setTemplates(unique.sort((a, b) => a.templateName.localeCompare(b.templateName)));
    } catch {
      setTemplates([]);
    } finally {
      setLoadingTemplates(false);
    }
  }

  async function loadContacts() {
    try {
      const data = await apiRequest<{ contacts: ConversationContact[] }>(
        `/conversations/list?phoneNumberId=${selectedNumber}`
      );
      setContacts(data.contacts);
    } catch (err) {
      console.error(err);
    }
  }

  async function loadMessages() {
    try {
      const data = await apiRequest<{ messages: ConversationMessage[] }>(
        `/conversations?phone=${selectedPhone}&phoneNumberId=${selectedNumber}`
      );
      setMessages(data.messages);
    } catch (err) {
      console.error(err);
    }
  }

  async function sendMessage() {
    if (!selectedPhone || !selectedNumber || !selectedBusiness) return;
    setSending(true);
    setSendError(null);
    setStatusMessage(null);

    try {
      const payload: Record<string, unknown> = {
        businessId: selectedBusiness,
        phoneNumberId: selectedNumber,
        phone: selectedPhone,
        contactName: selectedContact?.name,
      };

      if (isWithin24hWindow) {
        // Meta only allows free-form session messages within the 24h
        // customer-service window opened by the contact's last inbound
        // message — this branch was previously inverted (required a
        // template here instead), which silently blocked replies during
        // the exact window they're supposed to be allowed in.
        if (!messageText) {
          setSendError("Enter a chat message before sending.");
          return;
        }
        payload.messageType = "text";
        payload.messageText = messageText;
      } else {
        // Outside the window, Meta rejects anything but a pre-approved
        // template — this is the only way to re-open the conversation.
        if (!templateName) {
          setSendError("Select a template before sending.");
          return;
        }
        payload.messageType = "template";
        payload.templateName = templateName;
        if (templateParams.some((p) => p)) {
          payload.parameters = templateParams.filter((p) => p);
        }
      }

      await apiRequest("/conversations/send", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setStatusMessage("Message sent successfully.");
      setMessageText("");
      if (!isWithin24hWindow) setTemplateName("");
      await loadMessages();
    } catch (err: any) {
      console.error(err);
      setSendError(err?.message || "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  const business = businesses.find((b) => b.businessId === selectedBusiness);

  return (
    <AuthGuard>
      <AppShell mainClassName="flex-1 flex flex-col overflow-hidden pt-14 md:pt-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading...</div>
          ) : (
            <>
              {/* Header */}
              <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap gap-3 items-center bg-white">
                <div className="flex items-center gap-2 mr-2">
                  <div className="p-2 rounded-lg bg-primary-50 text-primary-600">
                    <MessageSquare className="w-5 h-5" />
                  </div>
                  <h1 className="text-xl font-bold text-gray-900">Conversations</h1>
                </div>

                <div className="flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-1.5 bg-white">
                  <Building2 className="w-4 h-4 text-gray-400" />
                  <select
                    value={selectedBusiness}
                    onChange={(e) => {
                      setSelectedBusiness(e.target.value);
                      const biz = businesses.find((b) => b.businessId === e.target.value);
                      if (biz?.phoneNumbers.length) setSelectedNumber(biz.phoneNumbers[0].phoneNumberId);
                    }}
                    className="text-sm bg-transparent outline-none text-gray-700"
                  >
                    {businesses.map((b) => (
                      <option key={b.businessId} value={b.businessId}>{b.businessName}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-1.5 bg-white">
                  <Phone className="w-4 h-4 text-gray-400" />
                  <select
                    value={selectedNumber}
                    onChange={(e) => setSelectedNumber(e.target.value)}
                    className="text-sm bg-transparent outline-none text-gray-700"
                  >
                    {business?.phoneNumbers.map((p) => (
                      <option key={p.phoneNumberId} value={p.phoneNumberId}>{p.displayName} ({p.displayNumber})</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Main area */}
              <div className="flex flex-1 overflow-hidden">
                {/* Contact list */}
                <div className="w-80 border-r border-gray-200 flex flex-col bg-white">
                  <div className="p-3 border-b border-gray-100">
                    <div className="relative">
                      <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search by name or phone..."
                        className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm bg-gray-50 focus:bg-white focus:border-primary-400 focus:ring-1 focus:ring-primary-400 outline-none transition-colors"
                      />
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto">
                    {filteredContacts.length === 0 && (
                      <p className="text-sm text-gray-400 p-4 text-center">
                        {contacts.length === 0 ? "No conversations yet" : "No contacts match your search"}
                      </p>
                    )}
                    {filteredContacts.map((c) => {
                      const isActive = selectedPhone === c.phone;
                      const needsReply = c.lastDirection === "inbound";
                      return (
                        <div
                          key={c.phone}
                          onClick={() => setSelectedPhone(c.phone)}
                          className={`flex items-start gap-3 px-3 py-3 border-b border-gray-50 cursor-pointer transition-colors ${
                            isActive ? "bg-primary-50 border-l-2 border-l-primary-600" : "hover:bg-gray-50 border-l-2 border-l-transparent"
                          }`}
                        >
                          <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold ${avatarColor(c.phone)}`}>
                            {initialsOf(c.name, c.phone)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-sm truncate ${isActive ? "font-semibold text-gray-900" : "font-medium text-gray-800"}`}>
                                {c.name || `+${c.phone}`}
                              </span>
                              <span className="text-[11px] text-gray-400 shrink-0">{formatRelativeTime(c.lastTimestamp)}</span>
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {needsReply && <span className="w-1.5 h-1.5 rounded-full bg-primary-500 shrink-0" />}
                              <p className={`text-xs truncate ${needsReply ? "text-gray-700" : "text-gray-400"}`}>
                                {c.lastDirection === "outbound" ? "You: " : ""}{c.lastMessage}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Chat area */}
                <div className="flex-1 flex flex-col bg-gray-50">
                  {!selectedPhone ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-2">
                      <MessageSquare className="w-10 h-10 text-gray-300" />
                      <p className="text-sm">Select a contact to view the conversation</p>
                    </div>
                  ) : (
                    <div className="flex flex-1 flex-col overflow-hidden">
                      <div className="px-4 py-3 bg-white border-b border-gray-200 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold ${avatarColor(selectedPhone)}`}>
                            {initialsOf(selectedContact?.name, selectedPhone)}
                          </div>
                          <div>
                            <div className="font-semibold text-gray-900 text-sm">{selectedContact?.name || `+${selectedPhone}`}</div>
                            <div className="text-xs text-gray-500">Active {formatRelativeTime(selectedContact?.lastTimestamp || "").toLowerCase()}</div>
                          </div>
                        </div>
                        <button
                          onClick={loadMessages}
                          className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-primary-600 border border-gray-200 hover:border-primary-300 rounded-lg px-2.5 py-1.5 transition-colors"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Refresh
                        </button>
                      </div>

                      <div className="flex-1 overflow-y-auto p-4 space-y-1">
                        {messages.map((msg, i) => {
                          const showDayLabel = i === 0 || formatDayLabel(msg.timestamp) !== formatDayLabel(messages[i - 1].timestamp);
                          return (
                            <div key={i}>
                              {showDayLabel && (
                                <div className="flex justify-center my-3">
                                  <span className="text-[11px] font-medium text-gray-500 bg-white border border-gray-200 rounded-full px-3 py-1">
                                    {formatDayLabel(msg.timestamp)}
                                  </span>
                                </div>
                              )}
                              <div className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"} mb-2`}>
                                <div
                                  className={`max-w-[70%] px-3.5 py-2.5 shadow-sm ${
                                    msg.direction === "outbound"
                                      ? "bg-primary-600 text-white rounded-2xl rounded-br-md"
                                      : "bg-white text-gray-900 rounded-2xl rounded-bl-md border border-gray-100"
                                  }`}
                                >
                                  <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                    <span className={`text-[10px] ${msg.direction === "outbound" ? "text-primary-100" : "text-gray-400"}`}>
                                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                    {msg.flowId && (
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${msg.direction === "outbound" ? "bg-primary-500 text-primary-50" : "bg-blue-50 text-blue-600"}`}>
                                        flow
                                      </span>
                                    )}
                                    {msg.messageType === "template" && (
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${msg.direction === "outbound" ? "bg-primary-500 text-primary-50" : "bg-purple-50 text-purple-600"}`}>
                                        template
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        <div ref={chatEndRef} />
                      </div>

                      <div className="border-t border-gray-200 bg-white p-4">
                        <div className="flex items-center justify-between gap-4 mb-3">
                          <div>
                            <div className="text-sm font-semibold text-gray-900">Send Message</div>
                            <div className="text-xs text-gray-500">
                              {isWithin24hWindow
                                ? "Within 24-hour session window: send a chat message."
                                : "Outside 24-hour window: send a template message to re-open the conversation."}
                            </div>
                          </div>
                          <span className={`flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${isWithin24hWindow ? "bg-primary-50 text-primary-700" : "bg-slate-100 text-slate-700"}`}>
                            <Clock className="w-3 h-3" />
                            {isWithin24hWindow ? "Chat mode" : "Template mode"}
                          </span>
                        </div>

                        {sendError && <div className="mb-2 text-sm text-red-600">{sendError}</div>}
                        {statusMessage && <div className="mb-2 text-sm text-primary-700">{statusMessage}</div>}

                        {isWithin24hWindow ? (
                          <div className="space-y-3">
                            <label className="block text-xs font-medium text-gray-600">Chat Message</label>
                            <textarea
                              value={messageText}
                              onChange={(e) => setMessageText(e.target.value)}
                              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm min-h-[100px] focus:border-primary-400 focus:ring-1 focus:ring-primary-400 outline-none"
                              placeholder="Type your chat message here"
                            />
                            <button
                              onClick={sendMessage}
                              disabled={sending}
                              className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
                            >
                              <Send className="w-4 h-4" />
                              {sending ? "Sending…" : "Send Chat Message"}
                            </button>
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-3">
                              <label className="block text-xs font-medium text-gray-600">Template Name</label>
                              <select
                                value={templateName}
                                onChange={(e) => {
                                  setTemplateName(e.target.value);
                                  const tpl = templates.find((t) => t.templateName === e.target.value);
                                  setTemplateParams(new Array(tpl?.parameterCount || 0).fill(""));
                                }}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-primary-400 focus:ring-1 focus:ring-primary-400 outline-none"
                              >
                                <option value="">{loadingTemplates ? "Loading..." : "Select a template"}</option>
                                {templates.map((t) => (
                                  <option key={t.templateName} value={t.templateName}>{t.templateName} ({t.parameterCount} params)</option>
                                ))}
                              </select>
                              {templateParams.length > 0 && (
                                <div className="space-y-2">
                                  <label className="block text-xs font-medium text-gray-600">Parameters</label>
                                  {templateParams.map((val, i) => (
                                    <input
                                      key={i}
                                      value={val}
                                      onChange={(e) => {
                                        const updated = [...templateParams];
                                        updated[i] = e.target.value;
                                        setTemplateParams(updated);
                                      }}
                                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-primary-400 focus:ring-1 focus:ring-primary-400 outline-none"
                                      placeholder={`Parameter {{${i + 1}}}`}
                                    />
                                  ))}
                                </div>
                              )}
                              <button
                                onClick={sendMessage}
                                disabled={sending || !templateName}
                                className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
                              >
                                <Send className="w-4 h-4" />
                                {sending ? "Sending…" : "Send Template Message"}
                              </button>
                            </div>
                            <TemplatePreview
                              template={(() => {
                                const tpl = templates.find((t) => t.templateName === templateName);
                                return tpl ? { components: tpl.components || [] } : null;
                              })()}
                              resolvedValues={Object.fromEntries(templateParams.map((v, i) => [String(i + 1), v]))}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Profile panel */}
                <div className="w-80 border-l border-gray-200 overflow-y-auto bg-white p-5">
                  <div className="text-sm font-semibold text-gray-900 pb-3 mb-4 border-b border-gray-100">Customer Profile</div>
                  {selectedContact ? (
                    <div className="space-y-4">
                      <div className="flex flex-col items-center text-center pb-2">
                        <div className={`w-16 h-16 rounded-full flex items-center justify-center text-lg font-semibold mb-3 ${avatarColor(selectedContact.phone)}`}>
                          {initialsOf(selectedContact.name, selectedContact.phone)}
                        </div>
                        <div className="text-base font-semibold text-gray-900">{selectedContact.name || `+${selectedContact.phone}`}</div>
                        <div className="text-sm text-gray-500 flex items-center gap-1 mt-0.5">
                          <Phone className="w-3.5 h-3.5" />
                          +{selectedContact.phone}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2.5">
                        <div className="flex items-center gap-3 rounded-lg border border-gray-200 p-3">
                          <div className="p-1.5 rounded-md bg-blue-50 text-blue-600 shrink-0">
                            <Clock className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-[11px] text-gray-500 uppercase tracking-wide">Last Message</div>
                            <div className="text-sm font-medium text-gray-900 truncate">{new Date(selectedContact.lastTimestamp).toLocaleString()}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 rounded-lg border border-gray-200 p-3">
                          <div className={`p-1.5 rounded-md shrink-0 ${isWithin24hWindow ? "bg-slate-100 text-slate-600" : "bg-primary-50 text-primary-600"}`}>
                            <CircleDot className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-[11px] text-gray-500 uppercase tracking-wide">Session Window</div>
                            <div className="text-sm font-medium text-gray-900">{isWithin24hWindow ? "24h active" : "24h expired"}</div>
                          </div>
                        </div>
                      </div>

                      {selectedContact.attributes && Object.keys(selectedContact.attributes).length > 0 && (
                        <div className="rounded-lg border border-gray-200 p-3">
                          <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-2">Attributes</div>
                          <div className="space-y-1.5 text-sm">
                            {Object.entries(selectedContact.attributes).map(([key, value]) => (
                              <div key={key} className="flex justify-between gap-2">
                                <span className="text-gray-500">{key}</span>
                                <span className="font-medium text-gray-900">{value}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-400">Select a contact to view profile information.</div>
                  )}
                </div>
              </div>
            </>
          )}
      </AppShell>
    </AuthGuard>
  );
}
