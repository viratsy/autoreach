"use client";

import { useState, useEffect } from "react";
import { apiRequest } from "@/lib/api";
import { Flow, FlowStep } from "@/types/flows";
import { Business } from "@/types";

export default function FlowsPage() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusiness, setSelectedBusiness] = useState("");
  const [showBuilder, setShowBuilder] = useState(false);
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadBusinesses();
  }, []);

  useEffect(() => {
    if (selectedBusiness) loadFlows();
  }, [selectedBusiness]);

  async function loadBusinesses() {
    try {
      const data = await apiRequest<{ businesses: Business[] }>("/businesses");
      setBusinesses(data.businesses);
      if (data.businesses.length > 0) {
        setSelectedBusiness(data.businesses[0].businessId);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function loadFlows() {
    try {
      const data = await apiRequest<{ flows: Flow[] }>(`/flows?businessId=${selectedBusiness}`);
      setFlows(data.flows);
    } catch (err) {
      console.error(err);
    }
  }

  async function toggleFlow(flow: Flow) {
    await apiRequest(`/flows/${flow.flowId}/toggle`, {
      method: "POST",
      body: JSON.stringify({ businessId: selectedBusiness }),
    });
    loadFlows();
  }

  async function deleteFlow(flowId: string) {
    if (!confirm("Delete this flow?")) return;
    await apiRequest(`/flows/${flowId}?businessId=${selectedBusiness}`, { method: "DELETE" });
    loadFlows();
  }

  if (loading) return <div className="p-6">Loading...</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Automation Flows</h1>
        <button
          onClick={() => { setEditingFlow(null); setShowBuilder(true); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          + New Flow
        </button>
      </div>

      {/* Business selector */}
      <div className="mb-4">
        <select
          value={selectedBusiness}
          onChange={(e) => setSelectedBusiness(e.target.value)}
          className="border rounded-lg px-3 py-2"
        >
          {businesses.map((b) => (
            <option key={b.businessId} value={b.businessId}>{b.businessName}</option>
          ))}
        </select>
      </div>

      {/* Flows list */}
      <div className="space-y-4">
        {flows.length === 0 && (
          <p className="text-gray-500">No automation flows yet. Create one to get started.</p>
        )}
        {flows.map((flow) => (
          <div key={flow.flowId} className="border rounded-lg p-4 bg-white shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-lg">{flow.flowName}</h3>
                <p className="text-sm text-gray-500">
                  Trigger: {flow.triggerType === "keyword_match" ? `Keywords: ${flow.triggerKeywords.join(", ")}` : flow.triggerType}
                </p>
                <p className="text-sm text-gray-500">{flow.steps.length} steps</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`px-2 py-1 text-xs rounded-full ${
                  flow.status === "active" ? "bg-green-100 text-green-700" :
                  flow.status === "paused" ? "bg-yellow-100 text-yellow-700" :
                  "bg-gray-100 text-gray-700"
                }`}>
                  {flow.status}
                </span>
                <button
                  onClick={() => toggleFlow(flow)}
                  className="text-sm text-blue-600 hover:underline"
                >
                  {flow.status === "active" ? "Pause" : "Activate"}
                </button>
                <button
                  onClick={() => { setEditingFlow(flow); setShowBuilder(true); }}
                  className="text-sm text-gray-600 hover:underline"
                >
                  Edit
                </button>
                <a
                  href={`/flows/builder?flowId=${flow.flowId}&businessId=${selectedBusiness}`}
                  className="text-sm text-indigo-600 hover:underline"
                >
                  Visual
                </a>
                <button
                  onClick={() => deleteFlow(flow.flowId)}
                  className="text-sm text-red-600 hover:underline"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Flow Builder Modal */}
      {showBuilder && (
        <FlowBuilder
          businessId={selectedBusiness}
          businesses={businesses}
          flow={editingFlow}
          onClose={() => setShowBuilder(false)}
          onSave={() => { setShowBuilder(false); loadFlows(); }}
        />
      )}
    </div>
  );
}

function FlowBuilder({
  businessId, businesses, flow, onClose, onSave,
}: {
  businessId: string;
  businesses: Business[];
  flow: Flow | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const [flowName, setFlowName] = useState(flow?.flowName || "");
  const [triggerType, setTriggerType] = useState(flow?.triggerType || "keyword_match");
  const [keywords, setKeywords] = useState(flow?.triggerKeywords?.join(", ") || "");
  const [phoneNumberId, setPhoneNumberId] = useState(flow?.phoneNumberId || "");
  const [steps, setSteps] = useState<FlowStep[]>(flow?.steps || []);
  const [saving, setSaving] = useState(false);

  const business = businesses.find((b) => b.businessId === businessId);

  function addStep(type: FlowStep["type"]) {
    const id = `step_${Date.now().toString(36)}`;
    const newStep: FlowStep = { id, type };
    if (type === "wait") { newStep.waitHours = 24; newStep.maxRetriggers = 2; }
    if (type === "wait_for_reply") { newStep.timeoutHours = 24; newStep.branches = []; }
    setSteps([...steps, newStep]);
  }

  function updateStep(index: number, updates: Partial<FlowStep>) {
    const updated = [...steps];
    updated[index] = { ...updated[index], ...updates };
    setSteps(updated);
  }

  function removeStep(index: number) {
    setSteps(steps.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        businessId,
        phoneNumberId,
        flowName,
        triggerKeywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
        triggerType,
        steps,
      };

      if (flow) {
        await apiRequest(`/flows/${flow.flowId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest("/flows", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      onSave();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white rounded-xl p-6 w-full max-w-3xl m-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold mb-4">{flow ? "Edit Flow" : "Create New Flow"}</h2>

        {/* Basic info */}
        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-medium mb-1">Flow Name</label>
            <input
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
              placeholder="e.g. Welcome Follow-up"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Phone Number</label>
            <select value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} className="w-full border rounded-lg px-3 py-2">
              <option value="">All numbers</option>
              {business?.phoneNumbers.map((p) => (
                <option key={p.phoneNumberId} value={p.phoneNumberId}>{p.displayName} ({p.displayNumber})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Trigger Type</label>
            <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as any)} className="w-full border rounded-lg px-3 py-2">
              <option value="keyword_match">Keyword Match</option>
              <option value="any_reply">Any Reply</option>
            </select>
          </div>

          {triggerType === "keyword_match" && (
            <div>
              <label className="block text-sm font-medium mb-1">Trigger Keywords (comma separated)</label>
              <input
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                className="w-full border rounded-lg px-3 py-2"
                placeholder="yes, interested, 1, join"
              />
            </div>
          )}
        </div>

        {/* Steps */}
        <div className="mb-6">
          <h3 className="font-semibold mb-3">Steps</h3>
          <div className="space-y-3">
            {steps.map((step, i) => (
              <StepEditor key={step.id} step={step} index={i} onUpdate={updateStep} onRemove={removeStep} />
            ))}
          </div>

          <div className="flex gap-2 mt-3 flex-wrap">
            <button onClick={() => addStep("send_message")} className="text-sm bg-green-50 text-green-700 px-3 py-1 rounded border border-green-200">+ Send Message</button>
            <button onClick={() => addStep("wait_for_reply")} className="text-sm bg-indigo-50 text-indigo-700 px-3 py-1 rounded border border-indigo-200">+ Wait for Reply</button>
            <button onClick={() => addStep("wait")} className="text-sm bg-orange-50 text-orange-700 px-3 py-1 rounded border border-orange-200">+ Delay</button>
            <button onClick={() => addStep("condition")} className="text-sm bg-purple-50 text-purple-700 px-3 py-1 rounded border border-purple-200">+ Condition</button>
            <button onClick={() => addStep("api_call")} className="text-sm bg-blue-50 text-blue-700 px-3 py-1 rounded border border-blue-200">+ API Call</button>
            <button onClick={() => addStep("tag")} className="text-sm bg-gray-50 text-gray-700 px-3 py-1 rounded border border-gray-200">+ Tag</button>
            <button onClick={() => addStep("end")} className="text-sm bg-slate-50 text-slate-700 px-3 py-1 rounded border border-slate-200">+ End Flow</button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving..." : "Save Flow"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StepEditor({ step, index, onUpdate, onRemove }: {
  step: FlowStep;
  index: number;
  onUpdate: (i: number, u: Partial<FlowStep>) => void;
  onRemove: (i: number) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function testApiCall() {
    if (!step.apiConfig?.url) return;
    setTesting(true);
    setTestResult(null);
    try {
      const body = step.apiConfig.body || undefined;
      const headers = step.apiConfig.headers || {};
      const res = await apiRequest<{ status: number; statusText: string; body: string }>("/flows/test-api", {
        method: "POST",
        body: JSON.stringify({
          url: step.apiConfig.url,
          method: step.apiConfig.method || "POST",
          headers,
          body,
        }),
      });
      setTestResult(`${res.status} ${res.statusText} — ${res.body.slice(0, 500)}`);
    } catch (err: any) {
      setTestResult(`Error: ${err.message}`);
    } finally {
      setTesting(false);
    }
  }

  const typeColors: Record<string, string> = {
    send_message: "border-green-300 bg-green-50",
    wait_for_reply: "border-indigo-300 bg-indigo-50",
    wait: "border-orange-300 bg-orange-50",
    condition: "border-purple-300 bg-purple-50",
    api_call: "border-blue-300 bg-blue-50",
    tag: "border-gray-300 bg-gray-50",
    end: "border-slate-300 bg-slate-50",
  };

  return (
    <div className={`border rounded-lg p-3 ${typeColors[step.type] || ""}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase">{index + 1}. {step.type.replace("_", " ")} <span className="text-gray-400 font-normal ml-1">({step.id})</span></span>
        <button onClick={() => onRemove(index)} className="text-red-500 text-xs">Remove</button>
      </div>

      {step.type === "send_message" && (
        <div className="space-y-2">
          <input
            value={step.templateName || ""}
            onChange={(e) => onUpdate(index, { templateName: e.target.value })}
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="Template name (or leave blank for text/buttons)"
          />
          <textarea
            value={step.messageText || ""}
            onChange={(e) => onUpdate(index, { messageText: e.target.value })}
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="Text message. Use {{name}}, {{phone}}, *bold*"
            rows={2}
          />

          {/* Buttons */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">Buttons (max 3):</p>
            {(step.replyButtons || []).map((btn, bi) => (
              <div key={bi} className="flex gap-1 mb-1">
                <input
                  value={btn}
                  onChange={(e) => {
                    const newBtns = [...(step.replyButtons || [])];
                    newBtns[bi] = e.target.value;
                    onUpdate(index, { replyButtons: newBtns });
                  }}
                  className="flex-1 border rounded px-2 py-1 text-sm"
                  placeholder={`Button ${bi + 1}`}
                  maxLength={20}
                />
                <button onClick={() => {
                  onUpdate(index, { replyButtons: (step.replyButtons || []).filter((_, i) => i !== bi) });
                }} className="text-red-400 text-xs px-1">✕</button>
              </div>
            ))}
            {(step.replyButtons?.length || 0) < 3 && (
              <button
                onClick={() => onUpdate(index, { replyButtons: [...(step.replyButtons || []), ""] })}
                className="text-xs text-green-600 hover:underline"
              >+ Add button</button>
            )}
          </div>

          {/* Image / Video */}
          <div className="flex gap-2">
            <input
              value={step.replyImageUrl || ""}
              onChange={(e) => onUpdate(index, { replyImageUrl: e.target.value, replyVideoUrl: "" })}
              className="flex-1 border rounded px-2 py-1 text-sm"
              placeholder="Image URL (optional)"
            />
            <input
              value={step.replyVideoUrl || ""}
              onChange={(e) => onUpdate(index, { replyVideoUrl: e.target.value, replyImageUrl: "" })}
              className="flex-1 border rounded px-2 py-1 text-sm"
              placeholder="Video URL (optional)"
            />
          </div>
          <p className="text-[10px] text-gray-400">Reply saved as {"{{last_reply}}"} — use Condition step next to branch</p>
        </div>
      )}

      {step.type === "wait_for_reply" && (
        <div className="space-y-2">
          <input
            value={step.replyMessage || ""}
            onChange={(e) => onUpdate(index, { replyMessage: e.target.value })}
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="Message to send (use {{name}}, {{phone}}). Leave blank for template."
          />
          <input
            value={step.replyTemplateName || ""}
            onChange={(e) => onUpdate(index, { replyTemplateName: e.target.value })}
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="Or template name (leave text blank if using template)"
          />
          <div className="border-t pt-2 mt-2">
            <p className="text-xs font-medium text-gray-600 mb-1">Reply Branches (if customer replies with...):</p>
            {(step.branches || []).map((branch, bi) => (
              <div key={bi} className="flex gap-1 mb-1 items-center">
                <input
                  value={branch.keywords.join(", ")}
                  onChange={(e) => {
                    const newBranches = [...(step.branches || [])];
                    newBranches[bi] = { ...branch, keywords: e.target.value.split(",").map((k) => k.trim()) };
                    onUpdate(index, { branches: newBranches });
                  }}
                  className="flex-1 border rounded px-2 py-1 text-xs"
                  placeholder="Keywords (e.g. yes, 1, interested)"
                />
                <span className="text-xs text-gray-400">→</span>
                <input
                  value={branch.nextStepId}
                  onChange={(e) => {
                    const newBranches = [...(step.branches || [])];
                    newBranches[bi] = { ...branch, nextStepId: e.target.value };
                    onUpdate(index, { branches: newBranches });
                  }}
                  className="w-32 border rounded px-2 py-1 text-xs"
                  placeholder="Step ID"
                />
                <button
                  onClick={() => {
                    const newBranches = (step.branches || []).filter((_, i) => i !== bi);
                    onUpdate(index, { branches: newBranches });
                  }}
                  className="text-red-400 text-xs"
                >✕</button>
              </div>
            ))}
            <button
              onClick={() => onUpdate(index, { branches: [...(step.branches || []), { keywords: [], nextStepId: "" }] })}
              className="text-xs text-indigo-600 hover:underline"
            >+ Add branch</button>
          </div>
          <input
            value={step.defaultNextStepId || ""}
            onChange={(e) => onUpdate(index, { defaultNextStepId: e.target.value })}
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="Default next step ID (if no branch matches)"
          />
          <div className="flex gap-2">
            <input
              type="number"
              value={step.timeoutHours || 24}
              onChange={(e) => onUpdate(index, { timeoutHours: Number(e.target.value) })}
              className="w-20 border rounded px-2 py-1 text-sm"
            />
            <span className="text-xs text-gray-500 self-center">hours timeout</span>
            <input
              value={step.timeoutNextStepId || ""}
              onChange={(e) => onUpdate(index, { timeoutNextStepId: e.target.value })}
              className="flex-1 border rounded px-2 py-1 text-sm"
              placeholder="On timeout → step ID (or leave blank to end)"
            />
          </div>
        </div>
      )}

      {step.type === "wait" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="number"
              value={step.waitHours || 24}
              onChange={(e) => onUpdate(index, { waitHours: Number(e.target.value) })}
              className="w-24 border rounded px-2 py-1 text-sm"
            />
            <span className="text-sm text-gray-600 self-center">hours</span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={step.retriggerOnNoReply || false}
              onChange={(e) => onUpdate(index, { retriggerOnNoReply: e.target.checked })}
            />
            Retrigger if no reply
          </label>
          {step.retriggerOnNoReply && (
            <>
              <input
                value={step.retriggerMessage || ""}
                onChange={(e) => onUpdate(index, { retriggerMessage: e.target.value })}
                className="w-full border rounded px-2 py-1 text-sm"
                placeholder="Reminder template name"
              />
              <div className="flex gap-2">
                <span className="text-sm text-gray-600">Max retriggers:</span>
                <input
                  type="number"
                  value={step.maxRetriggers || 3}
                  onChange={(e) => onUpdate(index, { maxRetriggers: Number(e.target.value) })}
                  className="w-16 border rounded px-2 py-1 text-sm"
                />
              </div>
            </>
          )}
        </div>
      )}

      {step.type === "condition" && (
        <div className="space-y-2">
          <select
            value={step.conditionType || "keyword"}
            onChange={(e) => onUpdate(index, { conditionType: e.target.value as any })}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value="keyword">Keyword Match (on reply)</option>
            <option value="any_reply">Any Reply</option>
            <option value="no_reply">No Reply</option>
            <option value="variable_check">Check Variable</option>
          </select>
          {step.conditionType === "keyword" && (
            <input
              value={step.keywords?.join(", ") || ""}
              onChange={(e) => onUpdate(index, { keywords: e.target.value.split(",").map((k) => k.trim()) })}
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder="Keywords (comma separated)"
            />
          )}
          {step.conditionType === "variable_check" && (
            <>
              <input
                value={step.conditionVariable || ""}
                onChange={(e) => onUpdate(index, { conditionVariable: e.target.value })}
                className="w-full border rounded px-2 py-1 text-sm"
                placeholder="Variable name (e.g. payment_status, last_reply)"
              />
              <select
                value={step.conditionOperator || "contains"}
                onChange={(e) => onUpdate(index, { conditionOperator: e.target.value as any })}
                className="border rounded px-2 py-1 text-sm"
              >
                <option value="contains">Contains</option>
                <option value="equals">Equals</option>
                <option value="not_equals">Not Equals</option>
                <option value="not_contains">Does Not Contain</option>
              </select>
              <input
                value={step.conditionValue || ""}
                onChange={(e) => onUpdate(index, { conditionValue: e.target.value })}
                className="w-full border rounded px-2 py-1 text-sm"
                placeholder="Value to compare (e.g. paid, true, success)"
              />
            </>
          )}
          <div className="flex gap-2">
            <input
              value={step.thenStepId || ""}
              onChange={(e) => onUpdate(index, { thenStepId: e.target.value })}
              className="flex-1 border rounded px-2 py-1 text-sm"
              placeholder="If TRUE → go to step ID"
            />
            <input
              value={step.elseStepId || ""}
              onChange={(e) => onUpdate(index, { elseStepId: e.target.value })}
              className="flex-1 border rounded px-2 py-1 text-sm"
              placeholder="If FALSE → go to step ID"
            />
          </div>
        </div>
      )}

      {step.type === "api_call" && (
        <div className="space-y-2">
          <select
            value={step.apiType || "webhook"}
            onChange={(e) => onUpdate(index, { apiType: e.target.value as any })}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value="webhook">Webhook / API</option>
            <option value="google_sheets">Google Sheets</option>
            <option value="database_search">Database Search</option>
          </select>
          <input
            value={step.apiConfig?.url || ""}
            onChange={(e) => onUpdate(index, { apiConfig: { ...step.apiConfig, url: e.target.value } })}
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="URL (webhook or Google Apps Script)"
          />
          {step.apiType === "database_search" && (
            <>
              <input
                value={step.apiConfig?.searchTable || ""}
                onChange={(e) => onUpdate(index, { apiConfig: { ...step.apiConfig, searchTable: e.target.value } })}
                className="w-full border rounded px-2 py-1 text-sm"
                placeholder="DynamoDB table name"
              />
              <input
                value={step.apiConfig?.searchKey || ""}
                onChange={(e) => onUpdate(index, { apiConfig: { ...step.apiConfig, searchKey: e.target.value } })}
                className="w-full border rounded px-2 py-1 text-sm"
                placeholder="Search key (use {{phone}} for contact phone)"
              />
            </>
          )}
          {(step.apiType === "webhook" || !step.apiType) && (
            <div className="space-y-2">
              <textarea
                value={step.apiConfig?.headers ? JSON.stringify(step.apiConfig.headers, null, 2) : ""}
                onChange={(e) => {
                  try {
                    const parsed = e.target.value ? JSON.parse(e.target.value) : {};
                    onUpdate(index, { apiConfig: { ...step.apiConfig, headers: parsed } });
                  } catch {
                    onUpdate(index, { apiConfig: { ...step.apiConfig, headers: {} } });
                  }
                }}
                className="w-full border rounded px-2 py-1 text-sm font-mono"
                placeholder='Headers JSON (e.g. {"x-api-key": "abc123"})'
                rows={2}
              />
              <textarea
                value={step.apiConfig?.body || ""}
                onChange={(e) => onUpdate(index, { apiConfig: { ...step.apiConfig, body: e.target.value } })}
                className="w-full border rounded px-2 py-1 text-sm font-mono"
                placeholder='Body JSON (e.g. {"Phone": "{{phone}}"}). Leave blank if not needed.'
                rows={2}
              />
            </div>
          )}
          <input
            value={step.apiConfig?.responseVariable || ""}
            onChange={(e) => onUpdate(index, { apiConfig: { ...step.apiConfig, responseVariable: e.target.value } })}
            className="w-full border rounded px-2 py-1 text-sm bg-yellow-50"
            placeholder="Save response as variable (e.g. payment_status)"
          />
          <button
            onClick={testApiCall}
            disabled={testing || !step.apiConfig?.url}
            className="w-full text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {testing ? "Testing..." : "🧪 Test API"}
          </button>
          {testResult && (
            <pre className="text-xs bg-white border rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
              {testResult}
            </pre>
          )}
        </div>
      )}

      {step.type === "tag" && (
        <input
          value={step.tagName || ""}
          onChange={(e) => onUpdate(index, { tagName: e.target.value })}
          className="w-full border rounded px-2 py-1 text-sm"
          placeholder="Tag name (e.g. interested, hot_lead)"
        />
      )}
    </div>
  );
}
