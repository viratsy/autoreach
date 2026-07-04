import { ScheduledHandler } from "aws-lambda";
import { ScanCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/dynamo";
import { FlowInstanceRecord, FlowRecord } from "../../lib/flow-types";
import { storeConversation } from "./execute";

const FLOW_INSTANCES_TABLE = process.env.FLOW_INSTANCES_TABLE!;
const FLOWS_TABLE = process.env.FLOWS_TABLE!;

/**
 * Runs every 15 minutes via EventBridge.
 * Checks for flow instances in "waiting" state whose waitUntil has expired.
 * Either retriggers (sends reminder) or advances/completes the flow.
 */
export const handler: ScheduledHandler = async () => {
  const now = new Date().toISOString();
  console.log(`Flow scheduler running at ${now}`);

  // Find all waiting instances with expired waitUntil
  const result = await docClient.send(
    new ScanCommand({
      TableName: FLOW_INSTANCES_TABLE,
      FilterExpression: "#status = :waiting AND waitUntil < :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":waiting": "waiting", ":now": now },
    })
  );

  const instances = (result.Items || []) as FlowInstanceRecord[];
  console.log(`Found ${instances.length} expired wait instances`);

  for (const instance of instances) {
    try {
      await processExpiredWait(instance);
    } catch (err) {
      console.error(`Error processing instance ${instance.instanceId}:`, err);
    }
  }
};

async function processExpiredWait(instance: FlowInstanceRecord) {
  // Load the flow definition
  const { ScanCommand: SC } = await import("@aws-sdk/lib-dynamodb");
  const flowResult = await docClient.send(
    new SC({
      TableName: FLOWS_TABLE,
      FilterExpression: "flowId = :fid",
      ExpressionAttributeValues: { ":fid": instance.flowId },
    })
  );

  const flow = flowResult.Items?.[0] as FlowRecord | undefined;
  if (!flow) {
    await markFailed(instance, "Flow definition not found");
    return;
  }

  const currentStep = flow.steps[instance.currentStepIndex];
  if (!currentStep || (currentStep.type !== "wait" && currentStep.type !== "wait_for_reply")) {
    // Not a wait step anymore, just advance
    await advanceToNextStep(instance, flow);
    return;
  }

  // Handle wait_for_reply timeout — customer didn't reply in time
  if (currentStep.type === "wait_for_reply") {
    const timeoutAction = currentStep.timeoutAction || "end";

    if (timeoutAction === "retry") {
      // Retry: resend the message and reset timer
      const retriggerCount = instance.retriggerCount || 0;
      const maxRetries = currentStep.timeoutMaxRetries || 2;

      if (retriggerCount < maxRetries) {
        // Resend the message
        const { storeConversation } = await import("./execute");
        // Just reset the wait timer and increment count
        const newWaitUntil = new Date(Date.now() + (currentStep.timeoutHours || 24) * 3600 * 1000).toISOString();
        await docClient.send(
          new UpdateCommand({
            TableName: FLOW_INSTANCES_TABLE,
            Key: { PK: instance.PK, SK: instance.SK },
            UpdateExpression: "SET retriggerCount = :rc, waitUntil = :wu, updatedAt = :now",
            ExpressionAttributeValues: {
              ":rc": retriggerCount + 1,
              ":wu": newWaitUntil,
              ":now": new Date().toISOString(),
            },
          })
        );

        // Send retry message if configured
        if (currentStep.timeoutRetryMessage) {
          const bizResult = await docClient.send(
            new GetCommand({
              TableName: process.env.BUSINESSES_TABLE!,
              Key: { PK: `BIZ#${flow.businessId}`, SK: "METADATA" },
            })
          );
          const business = bizResult.Item;
          if (business) {
            const accessToken = business.accessToken || process.env.META_ACCESS_TOKEN;
            const phoneNumberId = flow.phoneNumberId || business.phoneNumbers?.[0]?.phoneNumberId;
            await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                messaging_product: "whatsapp",
                to: instance.phone,
                type: "text",
                text: { body: currentStep.timeoutRetryMessage },
              }),
            });
          }
        }
        console.log(`Retry #${retriggerCount + 1} for ${instance.phone} flow ${instance.flowId}`);
        return;
      }
      // Max retries reached — fall through to end or goto
    }

    if (timeoutAction === "goto" && currentStep.timeoutNextStepId) {
      const timeoutIdx = flow.steps.findIndex((s) => s.id === currentStep.timeoutNextStepId);
      if (timeoutIdx >= 0) {
        await docClient.send(
          new UpdateCommand({
            TableName: FLOW_INSTANCES_TABLE,
            Key: { PK: instance.PK, SK: instance.SK },
            UpdateExpression: "SET currentStepIndex = :idx, #status = :s, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":idx": timeoutIdx, ":s": "running", ":now": new Date().toISOString() },
          })
        );
        return;
      }
    }

    // Default: end the flow
    await docClient.send(
      new UpdateCommand({
        TableName: FLOW_INSTANCES_TABLE,
        Key: { PK: instance.PK, SK: instance.SK },
        UpdateExpression: "SET #status = :s, updatedAt = :now, GSI1SK = :gsi",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":s": "completed", ":now": new Date().toISOString(), ":gsi": `STATUS#completed#${instance.phone}` },
      })
    );
    return;
  }

  // Check if we should retrigger
  if (currentStep.retriggerOnNoReply && instance.retriggerCount < (currentStep.maxRetriggers || 3)) {
    await sendRetrigger(instance, flow, currentStep);
  } else {
    // Max retriggers reached or no retrigger configured — advance to else branch or complete
    if (currentStep.elseStepId) {
      const elseIdx = flow.steps.findIndex((s) => s.id === currentStep.elseStepId);
      if (elseIdx >= 0) {
        await docClient.send(
          new UpdateCommand({
            TableName: FLOW_INSTANCES_TABLE,
            Key: { PK: instance.PK, SK: instance.SK },
            UpdateExpression: "SET currentStepIndex = :idx, #status = :s, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":idx": elseIdx,
              ":s": "running",
              ":now": new Date().toISOString(),
            },
          })
        );
        return;
      }
    }
    // No else branch — mark completed
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
}

async function sendRetrigger(instance: FlowInstanceRecord, flow: FlowRecord, step: any) {
  // Get business info for sending
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

  if (step.retriggerMessage) {
    // Send reminder template
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
          name: step.retriggerMessage,
          language: { code: "en" },
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
      content: `[Retrigger] ${step.retriggerMessage}`,
      metaMessageId: msgId,
      flowId: flow.flowId,
      timestamp: new Date().toISOString(),
    });
  }

  // Update retrigger count and reset wait timer
  const newWaitUntil = new Date(Date.now() + (step.waitHours || 24) * 3600 * 1000).toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: FLOW_INSTANCES_TABLE,
      Key: { PK: instance.PK, SK: instance.SK },
      UpdateExpression: "SET retriggerCount = :rc, waitUntil = :wu, updatedAt = :now",
      ExpressionAttributeValues: {
        ":rc": instance.retriggerCount + 1,
        ":wu": newWaitUntil,
        ":now": new Date().toISOString(),
      },
    })
  );

  console.log(`Retrigger #${instance.retriggerCount + 1} sent to ${instance.phone} for flow ${instance.flowId}`);
}

async function advanceToNextStep(instance: FlowInstanceRecord, flow: FlowRecord) {
  const nextIdx = instance.currentStepIndex + 1;
  if (nextIdx >= flow.steps.length) {
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
  } else {
    await docClient.send(
      new UpdateCommand({
        TableName: FLOW_INSTANCES_TABLE,
        Key: { PK: instance.PK, SK: instance.SK },
        UpdateExpression: "SET currentStepIndex = :idx, #status = :s, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":idx": nextIdx,
          ":s": "running",
          ":now": new Date().toISOString(),
        },
      })
    );
  }
}

async function markFailed(instance: FlowInstanceRecord, reason: string) {
  await docClient.send(
    new UpdateCommand({
      TableName: FLOW_INSTANCES_TABLE,
      Key: { PK: instance.PK, SK: instance.SK },
      UpdateExpression: "SET #status = :s, updatedAt = :now, failReason = :r, GSI1SK = :gsi",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": "failed",
        ":now": new Date().toISOString(),
        ":r": reason,
        ":gsi": `STATUS#failed#${instance.phone}`,
      },
    })
  );
}
