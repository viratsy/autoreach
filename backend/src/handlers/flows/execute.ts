import { PutCommand, GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { FlowRecord, FlowStep, FlowInstanceRecord, ConversationMessage } from "../../lib/flow-types";

const FLOWS_TABLE = process.env.FLOWS_TABLE!;
const FLOW_INSTANCES_TABLE = process.env.FLOW_INSTANCES_TABLE!;
const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE!;

/**
 * Called by the webhook handler when an incoming message is received.
 * Checks if the message matches any active flow triggers and starts/advances execution.
 */
export async function handleIncomingMessage(params: {
  phone: string;
  phoneNumberId: string;
  text: string;
  contactName: string;
  metaMessageId: string;
  businessId: string;
}) {
  const { phone, phoneNumberId, text, contactName, metaMessageId, businessId } = params;
  const now = new Date().toISOString();
  console.log(`Flow: handleIncomingMessage phone=${phone} text="${text}" biz=${businessId} num=${phoneNumberId}`);

  // 1. Store the conversation message
  await storeConversation({
    phone,
    phoneNumberId,
    direction: "inbound",
    messageType: "text",
    content: text,
    metaMessageId,
    timestamp: now,
  });

  // 2. Check if there's an active flow instance waiting for a reply
  const activeInstance = await findActiveInstance(phone);
  if (activeInstance) {
    await advanceFlowInstance(activeInstance, text, contactName);
    return;
  }

  // 3. Check if text matches any active flow trigger
  const matchedFlow = await findMatchingFlow(businessId, phoneNumberId, text);
  console.log(`Flow: matchedFlow=${matchedFlow ? matchedFlow.flowId : "NONE"} for text="${text}"`);
  if (matchedFlow) {
    await startFlowInstance(matchedFlow, phone, contactName);
  }
}

/**
 * Store a message in conversations table
 */
export async function storeConversation(params: {
  phone: string;
  phoneNumberId: string;
  direction: "inbound" | "outbound";
  messageType: "text" | "template" | "image";
  content: string;
  metaMessageId: string;
  flowId?: string;
  contactName?: string;
  timestamp: string;
}) {
  const { phone, phoneNumberId, direction, messageType, content, metaMessageId, flowId, contactName, timestamp } = params;

  const item: ConversationMessage = {
    PK: `PHONE#${phone}#NUM#${phoneNumberId}`,
    SK: `TS#${timestamp}#${direction}`,
    GSI1PK: `NUM#${phoneNumberId}`,
    GSI1SK: `TS#${timestamp}`,
    phone,
    phoneNumberId,
    direction,
    messageType,
    content,
    metaMessageId,
    flowId,
    contactName,
    timestamp,
  };

  await docClient.send(new PutCommand({ TableName: CONVERSATIONS_TABLE, Item: item }));
}

/**
 * Find an active flow instance that's waiting for a reply from this phone
 */
async function findActiveInstance(phone: string): Promise<FlowInstanceRecord | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: FLOW_INSTANCES_TABLE,
      KeyConditionExpression: "PK = :pk",
      FilterExpression: "#status = :waiting OR #status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pk": `PHONE#${phone}`,
        ":waiting": "waiting",
        ":running": "running",
      },
    })
  );

  return (result.Items?.[0] as FlowInstanceRecord) || null;
}

/**
 * Find a flow whose trigger keywords match the incoming text
 */
async function findMatchingFlow(
  businessId: string,
  phoneNumberId: string,
  text: string
): Promise<FlowRecord | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: FLOWS_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      FilterExpression: "#status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pk": `BIZ#${businessId}`,
        ":sk": "FLOW#",
        ":active": "active",
      },
    })
  );

  const flows = (result.Items || []) as FlowRecord[];
  const lowerText = text.toLowerCase().trim();

  for (const flow of flows) {
    // Match by phoneNumberId if specified
    if (flow.phoneNumberId && flow.phoneNumberId !== phoneNumberId) continue;

    if (flow.triggerType === "any_reply") return flow;

    if (flow.triggerType === "keyword_match") {
      const matched = flow.triggerKeywords.some((kw) => lowerText.includes(kw));
      if (matched) return flow;
    }
  }

  return null;
}

/**
 * Start a new flow instance for a contact
 */
async function startFlowInstance(flow: FlowRecord, phone: string, contactName: string) {
  const instanceId = `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  const instance: FlowInstanceRecord = {
    PK: `PHONE#${phone}`,
    SK: `FLOW#${flow.flowId}#${instanceId}`,
    GSI1PK: `FLOW#${flow.flowId}`,
    GSI1SK: `STATUS#running#${phone}`,
    instanceId,
    flowId: flow.flowId,
    phone,
    contactName,
    currentStepIndex: 0,
    status: "running",
    retriggerCount: 0,
    maxRetriggers: 3,
    stepResults: [],
    variables: {},
    startedAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: FLOW_INSTANCES_TABLE, Item: instance }));

  // Execute the first step
  if (flow.steps.length > 0) {
    await executeStep(flow, instance, flow.steps[0]);
  }
}

/**
 * Advance an existing flow instance based on customer reply
 */
async function advanceFlowInstance(instance: FlowInstanceRecord, text: string, contactName: string) {
  // Save the reply text into instance variables
  await docClient.send(
    new UpdateCommand({
      TableName: FLOW_INSTANCES_TABLE,
      Key: { PK: instance.PK, SK: instance.SK },
      UpdateExpression: "SET lastReply = :reply, variables.last_reply = :reply, updatedAt = :now",
      ExpressionAttributeValues: {
        ":reply": text,
        ":now": new Date().toISOString(),
      },
    })
  );
  instance.lastReply = text;
  if (!instance.variables) instance.variables = {};
  instance.variables["last_reply"] = text;

  // Load the flow definition
  // Load the flow definition by scanning (we don't store businessId in instance)
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const scanResult = await docClient.send(
    new ScanCommand({
      TableName: FLOWS_TABLE,
      FilterExpression: "flowId = :fid",
      ExpressionAttributeValues: { ":fid": instance.flowId },
    })
  );

  const flow = scanResult.Items?.[0] as FlowRecord | undefined;
  if (!flow) return;

  const currentStep = flow.steps[instance.currentStepIndex];
  if (!currentStep) return;

  // Handle wait_for_reply — this is the main conversation-driven step
  if (currentStep.type === "wait_for_reply") {
    const lowerText = text.toLowerCase().trim();
    let nextStepId: string | undefined;

    // Check branches for keyword match
    if (currentStep.branches?.length) {
      for (const branch of currentStep.branches) {
        const matched = branch.keywords.some((kw) => lowerText.includes(kw.toLowerCase()));
        if (matched) {
          nextStepId = branch.nextStepId;
          break;
        }
      }
    }

    // Fallback to default
    if (!nextStepId) nextStepId = currentStep.defaultNextStepId;

    if (nextStepId) {
      const nextIdx = flow.steps.findIndex((s) => s.id === nextStepId);
      if (nextIdx >= 0) {
        await docClient.send(
          new UpdateCommand({
            TableName: FLOW_INSTANCES_TABLE,
            Key: { PK: instance.PK, SK: instance.SK },
            UpdateExpression: "SET currentStepIndex = :idx, #status = :s, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":idx": nextIdx, ":s": "running", ":now": new Date().toISOString() },
          })
        );
        instance.currentStepIndex = nextIdx;
        await executeStep(flow, instance, flow.steps[nextIdx]);
        return;
      }
    }

    // No branch matched and no default — just move to next sequential step
    const seqNext = instance.currentStepIndex + 1;
    if (seqNext < flow.steps.length) {
      await docClient.send(
        new UpdateCommand({
          TableName: FLOW_INSTANCES_TABLE,
          Key: { PK: instance.PK, SK: instance.SK },
          UpdateExpression: "SET currentStepIndex = :idx, #status = :s, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":idx": seqNext, ":s": "running", ":now": new Date().toISOString() },
        })
      );
      instance.currentStepIndex = seqNext;
      await executeStep(flow, instance, flow.steps[seqNext]);
    } else {
      await markComplete(instance);
    }
    return;
  }

  // If current step is a wait or condition, evaluate
  if (currentStep.type === "wait" || currentStep.type === "condition") {
    const nextIndex = determineNextStep(flow, instance.currentStepIndex, text, instance);
    if (nextIndex !== null && nextIndex < flow.steps.length) {
      // Update instance to next step
      instance.currentStepIndex = nextIndex;
      instance.status = "running";
      instance.updatedAt = new Date().toISOString();

      await docClient.send(
        new UpdateCommand({
          TableName: FLOW_INSTANCES_TABLE,
          Key: { PK: instance.PK, SK: instance.SK },
          UpdateExpression: "SET currentStepIndex = :idx, #status = :s, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":idx": nextIndex,
            ":s": "running",
            ":now": new Date().toISOString(),
          },
        })
      );

      await executeStep(flow, instance, flow.steps[nextIndex]);
    } else {
      // No next step means the flow has reached its end.
      await markComplete(instance);
    }
  } else {
    // Move to next step
    const nextIndex = instance.currentStepIndex + 1;
    if (nextIndex < flow.steps.length) {
      await docClient.send(
        new UpdateCommand({
          TableName: FLOW_INSTANCES_TABLE,
          Key: { PK: instance.PK, SK: instance.SK },
          UpdateExpression: "SET currentStepIndex = :idx, updatedAt = :now",
          ExpressionAttributeValues: { ":idx": nextIndex, ":now": new Date().toISOString() },
        })
      );
      instance.currentStepIndex = nextIndex;
      await executeStep(flow, instance, flow.steps[nextIndex]);
    } else {
      // Flow complete
      await markComplete(instance);
    }
  }
}

/**
 * Determine which step to go to based on condition
 */
function determineNextStep(flow: FlowRecord, currentIndex: number, text: string, instance?: FlowInstanceRecord): number | null {
  const step = flow.steps[currentIndex];
  if (!step) return null;

  if (step.type === "condition") {
    const lowerText = text.toLowerCase().trim();

    if (step.conditionType === "keyword" && step.keywords?.length) {
      const matched = step.keywords.some((kw) => lowerText.includes(kw.toLowerCase()));
      if (matched && step.thenStepId) {
        const idx = flow.steps.findIndex((s) => s.id === step.thenStepId);
        return idx >= 0 ? idx : currentIndex + 1;
      } else if (step.elseStepId) {
        const idx = flow.steps.findIndex((s) => s.id === step.elseStepId);
        return idx >= 0 ? idx : currentIndex + 1;
      }
    }

    // Variable-based condition (check saved API response or reply)
    if (step.conditionType === "variable_check" && step.conditionVariable && instance) {
      const varValue = (instance.variables?.[step.conditionVariable] || "").toLowerCase();
      const checkValue = (step.conditionValue || "").toLowerCase();
      let matched = false;

      switch (step.conditionOperator) {
        case "contains": matched = varValue.includes(checkValue); break;
        case "equals": matched = varValue === checkValue; break;
        case "not_equals": matched = varValue !== checkValue; break;
        case "not_contains": matched = !varValue.includes(checkValue); break;
        default: matched = varValue.includes(checkValue);
      }

      if (matched && step.thenStepId) {
        const idx = flow.steps.findIndex((s) => s.id === step.thenStepId);
        return idx >= 0 ? idx : currentIndex + 1;
      } else if (!matched && step.elseStepId) {
        const idx = flow.steps.findIndex((s) => s.id === step.elseStepId);
        return idx >= 0 ? idx : currentIndex + 1;
      }
    }
  }

  // Default: next step
  return currentIndex + 1;
}

/**
 * Execute a single flow step
 */
async function executeStep(flow: FlowRecord, instance: FlowInstanceRecord, step: FlowStep) {
  const now = new Date().toISOString();

  switch (step.type) {
    case "send_message":
      await executeSendMessage(flow, instance, step);
      // If buttons are present, pause for reply (save as last_reply, then advance)
      if (step.replyButtons?.length) {
        await docClient.send(
          new UpdateCommand({
            TableName: FLOW_INSTANCES_TABLE,
            Key: { PK: instance.PK, SK: instance.SK },
            UpdateExpression: "SET #status = :s, waitUntil = :wu, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":s": "waiting",
              ":wu": new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
              ":now": now,
            },
          })
        );
        break;
      }
      // Auto-advance to next step after sending (no buttons)
      const nextIdx = instance.currentStepIndex + 1;
      if (nextIdx < flow.steps.length) {
        await docClient.send(
          new UpdateCommand({
            TableName: FLOW_INSTANCES_TABLE,
            Key: { PK: instance.PK, SK: instance.SK },
            UpdateExpression: "SET currentStepIndex = :idx, updatedAt = :now",
            ExpressionAttributeValues: { ":idx": nextIdx, ":now": now },
          })
        );
        instance.currentStepIndex = nextIdx;
        const nextStep = flow.steps[nextIdx];
        // Stop if next step waits for customer reply
        if (nextStep && nextStep.type === "wait_for_reply") {
          await executeStep(flow, instance, nextStep);
        } else if (nextStep && nextStep.type !== "wait" && nextStep.type !== "condition") {
          await executeStep(flow, instance, nextStep);
        } else if (nextStep?.type === "wait") {
          await enterWaitState(instance, nextStep);
        }
      } else {
        await markComplete(instance);
      }
      break;

    case "wait_for_reply":
      // Send the message (with optional buttons/image/video), then PARK
      await sendWaitForReplyMessage(flow, instance, step);
      // Set status to waiting — execution pauses here until reply comes in
      const waitTimeout = step.timeoutHours || 24;
      const waitUntilReply = new Date(Date.now() + waitTimeout * 3600 * 1000).toISOString();
      await docClient.send(
        new UpdateCommand({
          TableName: FLOW_INSTANCES_TABLE,
          Key: { PK: instance.PK, SK: instance.SK },
          UpdateExpression: "SET #status = :s, waitUntil = :wu, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": "waiting", ":wu": waitUntilReply, ":now": now },
        })
      );
      break;

    case "wait":
      await enterWaitState(instance, step);
      break;

    case "condition":
      // Condition steps wait for the next message to evaluate
      await docClient.send(
        new UpdateCommand({
          TableName: FLOW_INSTANCES_TABLE,
          Key: { PK: instance.PK, SK: instance.SK },
          UpdateExpression: "SET #status = :s, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": "waiting", ":now": now },
        })
      );
      break;

    case "api_call":
      await executeApiCall(flow, instance, step);
      // Auto-advance
      const apiNextIdx = instance.currentStepIndex + 1;
      if (apiNextIdx < flow.steps.length) {
        await docClient.send(
          new UpdateCommand({
            TableName: FLOW_INSTANCES_TABLE,
            Key: { PK: instance.PK, SK: instance.SK },
            UpdateExpression: "SET currentStepIndex = :idx, updatedAt = :now",
            ExpressionAttributeValues: { ":idx": apiNextIdx, ":now": now },
          })
        );
        instance.currentStepIndex = apiNextIdx;
        await executeStep(flow, instance, flow.steps[apiNextIdx]);
      } else {
        await markComplete(instance);
      }
      break;

    case "tag":
      // Store tag (could use a tags table or add to instance)
      console.log(`Tagging ${instance.phone} with: ${step.tagName}`);
      const tagNextIdx = instance.currentStepIndex + 1;
      if (tagNextIdx < flow.steps.length) {
        await docClient.send(
          new UpdateCommand({
            TableName: FLOW_INSTANCES_TABLE,
            Key: { PK: instance.PK, SK: instance.SK },
            UpdateExpression: "SET currentStepIndex = :idx, updatedAt = :now",
            ExpressionAttributeValues: { ":idx": tagNextIdx, ":now": now },
          })
        );
        instance.currentStepIndex = tagNextIdx;
        await executeStep(flow, instance, flow.steps[tagNextIdx]);
      } else {
        await markComplete(instance);
      }
      break;

    case "end":
      await markComplete(instance);
      break;
  }
}

/**
 * Send a WhatsApp message as part of a flow
 */
async function executeSendMessage(flow: FlowRecord, instance: FlowInstanceRecord, step: FlowStep) {
  // If step has buttons or image/video, use the interactive message sender
  if (step.replyButtons?.length || step.replyImageUrl || step.replyVideoUrl) {
    await sendWaitForReplyMessage(flow, instance, {
      ...step,
      replyMessage: step.messageText || step.replyMessage,
      replyTemplateName: step.templateName || step.replyTemplateName,
    });
    return;
  }

  // Get business access token
  const bizResult = await docClient.send(
    new GetCommand({
      TableName: process.env.BUSINESSES_TABLE!,
      Key: { PK: `BIZ#${flow.businessId}`, SK: "METADATA" },
    })
  );

  const business = bizResult.Item;
  if (!business) return;

  const accessToken = business.accessToken || process.env.META_ACCESS_TOKEN;
  const phoneNumberId = flow.phoneNumberId || business.phoneNumbers?.[0]?.phoneNumberId;

  if (step.messageText) {
    // Send as session text message (within 24h window)
    const response = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: instance.phone,
        type: "text",
        text: { body: interpolateText(step.messageText, instance) },
      }),
    });

    const data = (await response.json()) as { messages?: { id: string }[] };
    const msgId = data.messages?.[0]?.id || "";

    // Store outbound conversation
    await storeConversation({
      phone: instance.phone,
      phoneNumberId,
      direction: "outbound",
      messageType: "text",
      content: step.messageText,
      metaMessageId: msgId,
      flowId: flow.flowId,
      timestamp: new Date().toISOString(),
    });
  } else if (step.templateName) {
    // Send as template message
    const components: unknown[] = [];
    if (step.parameterMapping && Object.keys(step.parameterMapping).length > 0) {
      const parameters = Object.entries(step.parameterMapping)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, value]) => ({ type: "text", text: interpolateText(value, instance) }));
      components.push({ type: "body", parameters });
    }

    const response = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: instance.phone,
        type: "template",
        template: {
          name: step.templateName,
          language: { code: "en" },
          components,
        },
      }),
    });

    const data = (await response.json()) as { messages?: { id: string }[] };
    const msgId = data.messages?.[0]?.id || "";

    await storeConversation({
      phone: instance.phone,
      phoneNumberId,
      direction: "outbound",
      messageType: "template",
      content: step.templateName,
      metaMessageId: msgId,
      flowId: flow.flowId,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Send a wait_for_reply message — supports text with buttons, image, or video
 * Meta interactive messages: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-messages
 */
async function sendWaitForReplyMessage(flow: FlowRecord, instance: FlowInstanceRecord, step: FlowStep) {
  if (!step.replyMessage && !step.replyTemplateName && !step.replyImageUrl && !step.replyVideoUrl) return;

  const bizResult = await docClient.send(
    new GetCommand({
      TableName: process.env.BUSINESSES_TABLE!,
      Key: { PK: `BIZ#${flow.businessId}`, SK: "METADATA" },
    })
  );

  const business = bizResult.Item;
  if (!business) return;

  const accessToken = business.accessToken || process.env.META_ACCESS_TOKEN;
  const phoneNumberId = flow.phoneNumberId || business.phoneNumbers?.[0]?.phoneNumberId;
  const messageText = step.replyMessage ? interpolateText(step.replyMessage, instance) : "";

  let payload: Record<string, unknown>;

  // If buttons are defined, send as interactive message
  if (step.replyButtons && step.replyButtons.length > 0) {
    const buttons = step.replyButtons.slice(0, 3).map((text, i) => ({
      type: "reply",
      reply: { id: `btn_${i}`, title: text.slice(0, 20) }, // Max 20 chars per button
    }));

    const interactiveBody: Record<string, unknown> = {
      type: "button",
      body: { text: messageText },
      action: { buttons },
    };

    // Add header with image or video if provided
    if (step.replyImageUrl) {
      interactiveBody.header = { type: "image", image: { link: step.replyImageUrl } };
    } else if (step.replyVideoUrl) {
      interactiveBody.header = { type: "video", video: { link: step.replyVideoUrl } };
    }

    payload = {
      messaging_product: "whatsapp",
      to: instance.phone,
      type: "interactive",
      interactive: interactiveBody,
    };
  } else if (step.replyImageUrl) {
    // Image message without buttons
    payload = {
      messaging_product: "whatsapp",
      to: instance.phone,
      type: "image",
      image: { link: step.replyImageUrl, caption: messageText || undefined },
    };
  } else if (step.replyVideoUrl) {
    // Video message without buttons
    payload = {
      messaging_product: "whatsapp",
      to: instance.phone,
      type: "video",
      video: { link: step.replyVideoUrl, caption: messageText || undefined },
    };
  } else if (step.replyTemplateName) {
    // Template message
    payload = {
      messaging_product: "whatsapp",
      to: instance.phone,
      type: "template",
      template: { name: step.replyTemplateName, language: { code: "en" } },
    };
  } else {
    // Plain text
    payload = {
      messaging_product: "whatsapp",
      to: instance.phone,
      type: "text",
      text: { body: messageText },
    };
  }

  const response = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as { messages?: { id: string }[] };
  const msgId = data.messages?.[0]?.id || "";

  await storeConversation({
    phone: instance.phone,
    phoneNumberId,
    direction: "outbound",
    messageType: step.replyImageUrl ? "image" : "text",
    content: step.replyButtons?.length ? `[Buttons: ${step.replyButtons.join(", ")}] ${messageText}` : messageText || step.replyTemplateName || "",
    metaMessageId: msgId,
    flowId: flow.flowId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Put instance in wait state with a timeout
 */
async function enterWaitState(instance: FlowInstanceRecord, step: FlowStep) {
  const waitHours = step.waitHours || 24;
  const waitUntil = new Date(Date.now() + waitHours * 3600 * 1000).toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: FLOW_INSTANCES_TABLE,
      Key: { PK: instance.PK, SK: instance.SK },
      UpdateExpression: "SET #status = :s, waitUntil = :wu, updatedAt = :now, maxRetriggers = :mr",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": "waiting",
        ":wu": waitUntil,
        ":now": new Date().toISOString(),
        ":mr": step.maxRetriggers || 3,
      },
    })
  );
}

/**
 * Mark a flow instance as completed
 */
async function markComplete(instance: FlowInstanceRecord) {
  await docClient.send(
    new UpdateCommand({
      TableName: FLOW_INSTANCES_TABLE,
      Key: { PK: instance.PK, SK: instance.SK },
      UpdateExpression: "SET #status = :s, updatedAt = :now, GSI1SK = :gsi",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": "completed",
        ":now": new Date().toISOString(),
        ":gsi": `STATUS#completed#${instance.phone}`,
      },
    })
  );
}

/**
 * Execute an API call step (Google Sheets, DB search, webhook)
 */
async function executeApiCall(flow: FlowRecord, instance: FlowInstanceRecord, step: FlowStep) {
  const config = step.apiConfig;
  if (!config) return;

  let responseText = "";

  try {
    if (step.apiType === "webhook" && config.url) {
      const body = config.body ? interpolateText(config.body, instance) : JSON.stringify({ phone: instance.phone, contactName: instance.contactName });
      const response = await fetch(config.url, {
        method: config.method || "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.headers || {}),
        },
        body,
      });
      const result = await response.text();
      responseText = result;
      console.log(`API call result for ${instance.phone}:`, result);
    } else if (step.apiType === "google_sheets" && config.url) {
      const body = JSON.stringify({
        phone: instance.phone,
        contactName: instance.contactName,
        flowId: flow.flowId,
        timestamp: new Date().toISOString(),
      });
      const response = await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      responseText = await response.text();
    } else if (step.apiType === "database_search" && config.searchTable) {
      const result = await docClient.send(
        new QueryCommand({
          TableName: config.searchTable,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: {
            ":pk": interpolateText(config.searchKey || "", instance),
          },
          Limit: 10,
        })
      );
      responseText = JSON.stringify(result.Items || []);
      console.log(`DB search result for ${instance.phone}:`, result.Items?.length, "items");
    }

    // Save response into variable if configured
    if (config.responseVariable && responseText) {
      if (!instance.variables) instance.variables = {};
      instance.variables[config.responseVariable] = responseText;

      await docClient.send(
        new UpdateCommand({
          TableName: FLOW_INSTANCES_TABLE,
          Key: { PK: instance.PK, SK: instance.SK },
          UpdateExpression: `SET variables.#varName = :val, updatedAt = :now`,
          ExpressionAttributeNames: { "#varName": config.responseVariable },
          ExpressionAttributeValues: { ":val": responseText, ":now": new Date().toISOString() },
        })
      );
    }
  } catch (err) {
    console.error(`API call failed for step ${step.id}:`, err);
  }
}

/**
 * Replace placeholders in text: {{phone}}, {{name}}, {{flowId}}, {{last_reply}}, {{varName}}
 */
function interpolateText(text: string, instance: FlowInstanceRecord): string {
  let result = text
    .replace(/\{\{phone\}\}/g, instance.phone)
    .replace(/\{\{name\}\}/g, instance.contactName)
    .replace(/\{\{flowId\}\}/g, instance.flowId)
    .replace(/\{\{last_reply\}\}/g, instance.lastReply || "");

  // Replace any custom variables: {{varName}}
  if (instance.variables) {
    for (const [key, value] of Object.entries(instance.variables)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value || "");
    }
  }

  return result;
}
