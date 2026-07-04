"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import ReactFlow, {
  Node,
  Edge,
  addEdge,
  Connection,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  MarkerType,
  NodeProps,
  Handle,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import { apiRequest } from "@/lib/api";
import { Flow, FlowStep, FlowBranch } from "@/types/flows";

export default function FlowBuilderWrapper() {
  return (
    <Suspense fallback={<div className="p-6">Loading builder...</div>}>
      <FlowBuilderPage />
    </Suspense>
  );
}

// Custom node component
function StepNode({ data, selected }: NodeProps) {
  const colors: Record<string, string> = {
    send_message: "border-green-400 bg-green-50",
    wait_for_reply: "border-indigo-400 bg-indigo-50",
    wait: "border-orange-400 bg-orange-50",
    condition: "border-purple-400 bg-purple-50",
    api_call: "border-blue-400 bg-blue-50",
    tag: "border-gray-400 bg-gray-50",
    end: "border-slate-400 bg-slate-50",
    trigger: "border-red-400 bg-red-50",
  };

  const icons: Record<string, string> = {
    send_message: "💬",
    wait_for_reply: "⏳",
    wait: "⏰",
    condition: "🔀",
    api_call: "🔌",
    tag: "🏷️",
    end: "⛔",
    trigger: "⚡",
  };

  return (
    <div className={`px-3 py-2 rounded-lg border-2 shadow-sm min-w-[180px] max-w-[220px] ${colors[data.stepType] || "border-gray-300 bg-white"} ${selected ? "ring-2 ring-blue-500" : ""}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-3 !h-3" />
      <div className="text-[10px] font-bold uppercase text-gray-500 mb-1 flex items-center gap-1">
        <span>{icons[data.stepType] || "📦"}</span>
        {data.stepType?.replace("_", " ")}
      </div>
      <div className="text-xs text-gray-800 font-medium truncate">{data.label}</div>
      {data.subtitle && <div className="text-[10px] text-gray-500 truncate mt-0.5">{data.subtitle}</div>}
      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !w-3 !h-3" />
      {/* Extra handles for branching */}
      {data.stepType === "condition" && (
        <>
          <Handle type="source" position={Position.Right} id="true" className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "50%" }} />
          <Handle type="source" position={Position.Left} id="false" className="!bg-red-500 !w-2.5 !h-2.5" style={{ top: "50%" }} />
        </>
      )}
      {data.stepType === "wait_for_reply" && data.branches?.map((_: FlowBranch, i: number) => (
        <Handle key={i} type="source" position={Position.Right} id={`branch_${i}`} className="!bg-indigo-500 !w-2 !h-2" style={{ top: `${30 + i * 20}%` }} />
      ))}
    </div>
  );
}

const nodeTypes = { stepNode: StepNode };

function FlowBuilderPage() {
  const searchParams = useSearchParams();
  const flowId = searchParams.get("flowId");
  const businessId = searchParams.get("businessId");

  const [flow, setFlow] = useState<Flow | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedStep, setSelectedStep] = useState<FlowStep | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (flowId && businessId) loadFlow();
  }, [flowId, businessId]);

  async function loadFlow() {
    const data = await apiRequest<{ flow: Flow }>(`/flows/${flowId}?businessId=${businessId}`);
    setFlow(data.flow);
    buildGraph(data.flow.steps);
  }

  function buildGraph(steps: FlowStep[]) {
    const newNodes: Node[] = [
      {
        id: "trigger",
        type: "stepNode",
        position: { x: 250, y: 0 },
        data: { stepType: "trigger", label: "Trigger", subtitle: flow?.triggerKeywords?.join(", ") || "Keyword" },
      },
    ];

    const newEdges: Edge[] = [];

    steps.forEach((step, i) => {
      newNodes.push({
        id: step.id,
        type: "stepNode",
        position: { x: 250, y: 100 + i * 140 },
        data: {
          stepType: step.type,
          label: getStepLabel(step),
          subtitle: getStepSubtitle(step),
          branches: step.branches,
        },
      });

      // Connect to previous
      if (i === 0) {
        newEdges.push({ id: `trigger->${step.id}`, source: "trigger", target: step.id, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6b7280" } });
      }
    });

    // Build edges from step connections
    steps.forEach((step, i) => {
      const nextStep = steps[i + 1];

      if (step.type === "condition") {
        if (step.thenStepId) {
          newEdges.push({ id: `${step.id}->true`, source: step.id, sourceHandle: "true", target: step.thenStepId, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#22c55e" }, label: "Yes" });
        }
        if (step.elseStepId) {
          newEdges.push({ id: `${step.id}->false`, source: step.id, sourceHandle: "false", target: step.elseStepId, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#ef4444" }, label: "No" });
        }
        if (!step.thenStepId && !step.elseStepId && nextStep) {
          newEdges.push({ id: `${step.id}->${nextStep.id}`, source: step.id, target: nextStep.id, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6b7280" } });
        }
      } else if (step.type === "wait_for_reply") {
        step.branches?.forEach((branch, bi) => {
          if (branch.nextStepId) {
            newEdges.push({ id: `${step.id}->branch_${bi}`, source: step.id, sourceHandle: `branch_${bi}`, target: branch.nextStepId, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6366f1" }, label: branch.keywords[0] || "" });
          }
        });
        if (step.defaultNextStepId) {
          newEdges.push({ id: `${step.id}->default`, source: step.id, target: step.defaultNextStepId, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6b7280" }, label: "Default" });
        } else if (nextStep) {
          newEdges.push({ id: `${step.id}->${nextStep.id}`, source: step.id, target: nextStep.id, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6b7280" } });
        }
      } else if (nextStep) {
        newEdges.push({ id: `${step.id}->${nextStep.id}`, source: step.id, target: nextStep.id, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6b7280" } });
      }
    });

    setNodes(newNodes);
    setEdges(newEdges);
  }

  function getStepLabel(step: FlowStep): string {
    switch (step.type) {
      case "send_message": return step.messageText?.slice(0, 30) || step.templateName || "Send Message";
      case "wait_for_reply": return step.replyMessage?.slice(0, 30) || "Wait for Reply";
      case "wait": return `Delay ${step.waitHours || 24}h`;
      case "condition": return step.conditionVariable ? `If ${step.conditionVariable}` : "Condition";
      case "api_call": return step.apiConfig?.url?.split("/").pop() || "API Call";
      case "tag": return `Tag: ${step.tagName || ""}`;
      case "end": return "End Flow";
      default: return step.type;
    }
  }

  function getStepSubtitle(step: FlowStep): string {
    switch (step.type) {
      case "send_message": return step.replyButtons?.length ? `Buttons: ${step.replyButtons.join(", ")}` : "";
      case "wait_for_reply": return step.replyButtons?.length ? `[${step.replyButtons.join(", ")}]` : "";
      case "condition": return `${step.conditionOperator || "check"} "${step.conditionValue || ""}"`;
      case "api_call": return step.apiConfig?.responseVariable ? `→ ${step.apiConfig.responseVariable}` : "";
      case "end": return "End the current automation flow.";
      default: return "";
    }
  }

  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => addEdge({ ...params, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6b7280" } }, eds));
  }, [setEdges]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.id === "trigger") return;
    const step = flow?.steps.find((s) => s.id === node.id);
    if (step) setSelectedStep(step);
  }, [flow]);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setEdges((eds) => eds.filter((e) => e.id !== edge.id));
  }, [setEdges]);

  function addStep(type: FlowStep["type"]) {
    if (!flow) return;
    const id = `step_${Date.now().toString(36)}`;
    const newStep: FlowStep = { id, type };
    if (type === "wait") newStep.waitHours = 24;
    if (type === "wait_for_reply") { newStep.timeoutHours = 24; newStep.branches = []; }
    const updatedSteps = [...flow.steps, newStep];
    setFlow({ ...flow, steps: updatedSteps });
    buildGraph(updatedSteps);
  }

  async function saveFlow() {
    if (!flow || !flowId || !businessId) return;
    setSaving(true);
    try {
      await apiRequest(`/flows/${flowId}`, {
        method: "PUT",
        body: JSON.stringify({
          businessId,
          flowName: flow.flowName,
          triggerKeywords: flow.triggerKeywords,
          triggerType: flow.triggerType,
          phoneNumberId: flow.phoneNumberId,
          steps: flow.steps,
        }),
      });
      alert("Flow saved!");
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  if (!flow) return <div className="p-6">Loading flow...</div>;

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <div className="p-3 border-b bg-white flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a href="/flows" className="text-sm text-gray-500 hover:text-gray-700">← Back</a>
          <h1 className="font-bold text-lg">{flow.flowName}</h1>
          <span className={`text-xs px-2 py-0.5 rounded-full ${flow.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>{flow.status}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={saveFlow} disabled={saving} className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Canvas */}
        <div className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            nodeTypes={nodeTypes}
            fitView
            className="bg-gray-50"
          >
            <Controls />
            <Background gap={20} size={1} />
          </ReactFlow>
        </div>

        {/* Side panel */}
        <div className="w-72 border-l bg-white overflow-y-auto p-3">
          {/* Add node buttons */}
          <p className="text-xs font-bold text-gray-500 uppercase mb-2">Add Step</p>
          <div className="grid grid-cols-2 gap-1 mb-4">
            <button onClick={() => addStep("send_message")} className="text-[10px] p-1.5 bg-green-50 text-green-700 rounded border border-green-200 hover:bg-green-100">💬 Message</button>
            <button onClick={() => addStep("wait_for_reply")} className="text-[10px] p-1.5 bg-indigo-50 text-indigo-700 rounded border border-indigo-200 hover:bg-indigo-100">⏳ Wait Reply</button>
            <button onClick={() => addStep("condition")} className="text-[10px] p-1.5 bg-purple-50 text-purple-700 rounded border border-purple-200 hover:bg-purple-100">🔀 Condition</button>
            <button onClick={() => addStep("api_call")} className="text-[10px] p-1.5 bg-blue-50 text-blue-700 rounded border border-blue-200 hover:bg-blue-100">🔌 API Call</button>
            <button onClick={() => addStep("wait")} className="text-[10px] p-1.5 bg-orange-50 text-orange-700 rounded border border-orange-200 hover:bg-orange-100">⏰ Delay</button>
            <button onClick={() => addStep("tag")} className="text-[10px] p-1.5 bg-gray-50 text-gray-700 rounded border border-gray-200 hover:bg-gray-100">🏷️ Tag</button>
            <button onClick={() => addStep("end")} className="text-[10px] p-1.5 bg-slate-50 text-slate-700 rounded border border-slate-200 hover:bg-slate-100">⛔ End Flow</button>
          </div>

          {/* Selected step editor */}
          {selectedStep && (
            <div className="border-t pt-3">
              <p className="text-xs font-bold text-gray-500 uppercase mb-2">Edit: {selectedStep.type.replace("_", " ")}</p>
              <p className="text-[10px] text-gray-400 mb-2">ID: {selectedStep.id}</p>

              {selectedStep.type === "send_message" && (
                <div className="space-y-2">
                  <textarea value={selectedStep.messageText || ""} onChange={(e) => updateSelectedStep({ messageText: e.target.value })} className="w-full border rounded px-2 py-1 text-xs" rows={3} placeholder="Message text" />
                  <input value={selectedStep.templateName || ""} onChange={(e) => updateSelectedStep({ templateName: e.target.value })} className="w-full border rounded px-2 py-1 text-xs" placeholder="Template name" />
                </div>
              )}

              {selectedStep.type === "wait_for_reply" && (
                <div className="space-y-2">
                  <textarea value={selectedStep.replyMessage || ""} onChange={(e) => updateSelectedStep({ replyMessage: e.target.value })} className="w-full border rounded px-2 py-1 text-xs" rows={3} placeholder="Message with buttons" />
                  <p className="text-[10px] text-gray-500">Buttons: {selectedStep.replyButtons?.join(", ") || "None"}</p>
                </div>
              )}

              {selectedStep.type === "condition" && (
                <div className="space-y-2">
                  <input value={selectedStep.conditionVariable || ""} onChange={(e) => updateSelectedStep({ conditionVariable: e.target.value })} className="w-full border rounded px-2 py-1 text-xs" placeholder="Variable name" />
                  <input value={selectedStep.conditionValue || ""} onChange={(e) => updateSelectedStep({ conditionValue: e.target.value })} className="w-full border rounded px-2 py-1 text-xs" placeholder="Value to compare" />
                  <input value={selectedStep.thenStepId || ""} onChange={(e) => updateSelectedStep({ thenStepId: e.target.value })} className="w-full border rounded px-2 py-1 text-xs" placeholder="If TRUE → step ID" />
                  <input value={selectedStep.elseStepId || ""} onChange={(e) => updateSelectedStep({ elseStepId: e.target.value })} className="w-full border rounded px-2 py-1 text-xs" placeholder="If FALSE → step ID" />
                </div>
              )}

              {selectedStep.type === "api_call" && (
                <div className="space-y-2">
                  <input value={selectedStep.apiConfig?.url || ""} onChange={(e) => updateSelectedStep({ apiConfig: { ...selectedStep.apiConfig, url: e.target.value } })} className="w-full border rounded px-2 py-1 text-xs" placeholder="API URL" />
                  <input value={selectedStep.apiConfig?.responseVariable || ""} onChange={(e) => updateSelectedStep({ apiConfig: { ...selectedStep.apiConfig, responseVariable: e.target.value } })} className="w-full border rounded px-2 py-1 text-xs" placeholder="Save as variable" />
                </div>
              )}

              {selectedStep.type === "wait" && (
                <input type="number" value={selectedStep.waitHours || 24} onChange={(e) => updateSelectedStep({ waitHours: Number(e.target.value) })} className="w-full border rounded px-2 py-1 text-xs" placeholder="Hours" />
              )}

              {selectedStep.type === "tag" && (
                <input value={selectedStep.tagName || ""} onChange={(e) => updateSelectedStep({ tagName: e.target.value })} className="w-full border rounded px-2 py-1 text-xs" placeholder="Tag name" />
              )}

              <button onClick={() => removeStep(selectedStep.id)} className="mt-3 text-xs text-red-600 hover:underline">Remove step</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  function updateSelectedStep(updates: Partial<FlowStep>) {
    if (!flow || !selectedStep) return;
    const updatedSteps = flow.steps.map((s) => s.id === selectedStep.id ? { ...s, ...updates } : s);
    const updatedStep = { ...selectedStep, ...updates };
    setFlow({ ...flow, steps: updatedSteps });
    setSelectedStep(updatedStep);
    buildGraph(updatedSteps);
  }

  function removeStep(stepId: string) {
    if (!flow) return;
    const updatedSteps = flow.steps.filter((s) => s.id !== stepId);
    setFlow({ ...flow, steps: updatedSteps });
    setSelectedStep(null);
    buildGraph(updatedSteps);
  }
}
