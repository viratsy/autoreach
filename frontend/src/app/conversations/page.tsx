"use client";

import { useState, useEffect, useRef } from "react";
import { apiRequest } from "@/lib/api";
import { ConversationContact, ConversationMessage } from "@/types/flows";
import { Business } from "@/types";

export default function ConversationsPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusiness, setSelectedBusiness] = useState("");
  const [selectedNumber, setSelectedNumber] = useState("");
  const [contacts, setContacts] = useState<ConversationContact[]>([]);
  const [selectedPhone, setSelectedPhone] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templates, setTemplates] = useState<{ templateName: string; parameterCount: number }[]>([]);
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
      const data = await apiRequest<{ templates: { templateName: string; parameterCount: number }[] }>(
        `/templates?businessId=${selectedBusiness}&phoneNumberIds=${selectedNumber}`
      );
      const unique = data.templates.reduce((acc, t) => {
        if (!acc.find((x) => x.templateName === t.templateName)) acc.push(t);
        return acc;
      }, [] as { templateName: string; parameterCount: number }[]);
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
        if (!templateName) {
          setSendError("Enter a template name before sending a template message.");
          return;
        }
        payload.messageType = "template";
        payload.templateName = templateName;
        if (templateParams.some((p) => p)) {
          payload.parameters = templateParams.filter((p) => p);
        }
      } else {
        if (!messageText) {
          setSendError("Enter a chat message before sending.");
          return;
        }
        payload.messageType = "text";
        payload.messageText = messageText;
      }

      await apiRequest("/conversations/send", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setStatusMessage("Message sent successfully.");
      setMessageText("");
      if (isWithin24hWindow) setTemplateName("");
      await loadMessages();
    } catch (err: any) {
      console.error(err);
      setSendError(err?.message || "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  const business = businesses.find((b) => b.businessId === selectedBusiness);

  if (loading) return <div className="p-6">Loading...</div>;

  return (
    <div className="h-[calc(100vh-64px)] flex flex-col">
      {/* Header */}
      <div className="p-4 border-b flex gap-4 items-center bg-white">
        <h1 className="text-xl font-bold">Conversations</h1>
        <select
          value={selectedBusiness}
          onChange={(e) => {
            setSelectedBusiness(e.target.value);
            const biz = businesses.find((b) => b.businessId === e.target.value);
            if (biz?.phoneNumbers.length) setSelectedNumber(biz.phoneNumbers[0].phoneNumberId);
          }}
          className="border rounded px-3 py-1 text-sm"
        >
          {businesses.map((b) => (
            <option key={b.businessId} value={b.businessId}>{b.businessName}</option>
          ))}
        </select>
        <select
          value={selectedNumber}
          onChange={(e) => setSelectedNumber(e.target.value)}
          className="border rounded px-3 py-1 text-sm"
        >
          {business?.phoneNumbers.map((p) => (
            <option key={p.phoneNumberId} value={p.phoneNumberId}>{p.displayName} ({p.displayNumber})</option>
          ))}
        </select>
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Contact list */}
        <div className="w-80 border-r overflow-y-auto bg-gray-50">
          {contacts.length === 0 && (
            <p className="text-sm text-gray-500 p-4">No conversations yet</p>
          )}
          {contacts.map((c) => (
            <div
              key={c.phone}
              onClick={() => setSelectedPhone(c.phone)}
              className={`p-3 border-b cursor-pointer hover:bg-white transition ${
                selectedPhone === c.phone ? "bg-white border-l-4 border-l-blue-500" : ""
              }`}
            >
              <div className="font-medium text-sm">{c.name || `+${c.phone}`}</div>
              <div className="text-xs text-gray-500 truncate">
                {c.lastDirection === "outbound" ? "You: " : ""}{c.lastMessage}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {new Date(c.lastTimestamp).toLocaleString()}
              </div>
            </div>
          ))}
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col bg-gray-100">
          {!selectedPhone ? (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              Select a contact to view conversation
            </div>
          ) : (
            <div className="flex flex-1 flex-col">
              <div className="p-3 bg-white border-b flex items-center justify-between">
                <div>
                  <div className="font-medium">{selectedContact?.name || `+${selectedPhone}`}</div>
                  <div className="text-xs text-gray-500">Last activity: {new Date(selectedContact?.lastTimestamp || "").toLocaleString()}</div>
                </div>
                <button onClick={loadMessages} className="text-sm text-blue-600 hover:underline">Refresh</button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[70%] rounded-lg px-3 py-2 ${
                        msg.direction === "outbound"
                          ? "bg-green-100 text-green-900"
                          : "bg-white text-gray-900 shadow-sm"
                      }`}
                    >
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className="text-[10px] text-gray-400">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        {msg.flowId && <span className="text-[10px] bg-blue-100 text-blue-600 px-1 rounded">flow</span>}
                        {msg.messageType === "template" && <span className="text-[10px] bg-purple-100 text-purple-600 px-1 rounded">template</span>}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              <div className="border-t bg-white p-4">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <div>
                    <div className="text-sm font-semibold">Send Message</div>
                    <div className="text-xs text-gray-500">
                      {isWithin24hWindow
                        ? "Within 24-hour session window: send a template message."
                        : "Outside 24-hour window: use chat text input."}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded ${isWithin24hWindow ? "bg-slate-100 text-slate-700" : "bg-green-100 text-green-700"}`}>
                    {isWithin24hWindow ? "Template mode" : "Chat mode"}
                  </span>
                </div>

                {sendError && <div className="mb-2 text-sm text-red-600">{sendError}</div>}
                {statusMessage && <div className="mb-2 text-sm text-green-600">{statusMessage}</div>}

                {isWithin24hWindow ? (
                  <div className="space-y-3">
                    <label className="block text-xs font-medium text-gray-600">Template Name</label>
                    <select
                      value={templateName}
                      onChange={(e) => {
                        setTemplateName(e.target.value);
                        const tpl = templates.find((t) => t.templateName === e.target.value);
                        setTemplateParams(new Array(tpl?.parameterCount || 0).fill(""));
                      }}
                      className="w-full border rounded-lg px-3 py-2 text-sm"
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
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                            placeholder={`Parameter {{${i + 1}}}`}
                          />
                        ))}
                      </div>
                    )}
                    <button
                      onClick={sendMessage}
                      disabled={sending || !templateName}
                      className="w-full rounded-lg bg-blue-600 text-white px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
                    >
                      {sending ? "Sending…" : "Send Template Message"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <label className="block text-xs font-medium text-gray-600">Chat Message</label>
                    <textarea
                      value={messageText}
                      onChange={(e) => setMessageText(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm min-h-[100px]"
                      placeholder="Type your chat message here"
                    />
                    <button
                      onClick={sendMessage}
                      disabled={sending}
                      className="w-full rounded-lg bg-green-600 text-white px-4 py-2 hover:bg-green-700 disabled:opacity-50"
                    >
                      {sending ? "Sending…" : "Send Chat Message"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Profile panel */}
        <div className="w-96 border-l overflow-y-auto bg-white p-4">
          <div className="sticky top-0 z-10 bg-white pb-4 mb-4 border-b">
            <div className="text-sm font-semibold">Customer Profile</div>
          </div>
          {selectedContact ? (
            <div className="space-y-4">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Contact</div>
                <div className="text-lg font-semibold">{selectedContact.name || `+${selectedContact.phone}`}</div>
                <div className="text-sm text-gray-500">{selectedContact.phone}</div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="text-xs text-gray-500 uppercase mb-1">Last Message</div>
                  <div className="font-medium">{new Date(selectedContact.lastTimestamp).toLocaleString()}</div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="text-xs text-gray-500 uppercase mb-1">Window</div>
                  <div className="font-medium">{isWithin24hWindow ? "24h active" : "24h expired"}</div>
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="text-xs text-gray-500 uppercase mb-2">Attributes</div>
                {selectedContact.attributes ? (
                  <div className="space-y-1 text-sm">
                    {Object.entries(selectedContact.attributes).map(([key, value]) => (
                      <div key={key} className="flex justify-between gap-2">
                        <span className="text-gray-600">{key}</span>
                        <span className="font-medium text-gray-900">{value}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">No profile attributes available.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-500">Select a contact to view profile information.</div>
          )}
        </div>
      </div>
    </div>
  );
}
