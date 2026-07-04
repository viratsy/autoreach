// Automation Flow types

export interface FlowBranch {
  keywords: string[]; // If reply contains any of these keywords
  nextStepId: string; // Jump to this step
}

export interface FlowStep {
  id: string;
  type: "send_message" | "wait_for_reply" | "wait" | "condition" | "api_call" | "tag" | "end";

  // send_message — sends and immediately moves to next step
  templateName?: string;
  messageText?: string;
  parameterMapping?: Record<string, string>;

  // wait_for_reply — sends a message then PAUSES until customer replies
  // When they reply, branches based on reply content
  replyMessage?: string; // Text message to send before waiting
  replyTemplateName?: string; // Or template to send before waiting
  replyButtons?: string[]; // Quick reply buttons (max 3, Meta limit)
  replyImageUrl?: string; // Image URL to send with message
  replyVideoUrl?: string; // Video URL to send with message
  branches?: FlowBranch[]; // Route based on reply keywords
  defaultNextStepId?: string; // If no branch matches
  timeoutHours?: number; // Max wait time (default 24h)
  timeoutAction?: "end" | "retry" | "goto"; // What to do on timeout
  timeoutRetryMessage?: string; // Message to send on retry
  timeoutMaxRetries?: number; // Max retries before giving up
  timeoutNextStepId?: string; // Where to go on timeout (if goto)

  // wait — pure time delay
  waitHours?: number;
  retriggerOnNoReply?: boolean;
  retriggerMessage?: string;
  maxRetriggers?: number;

  // condition — checks a variable without waiting
  conditionType?: "keyword" | "any_reply" | "no_reply" | "variable_check";
  keywords?: string[];
  thenStepId?: string;
  elseStepId?: string;
  conditionVariable?: string;
  conditionOperator?: "contains" | "equals" | "not_equals" | "not_contains";
  conditionValue?: string;

  // api_call
  apiType?: "google_sheets" | "database_search" | "webhook";
  apiConfig?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    sheetId?: string;
    sheetRange?: string;
    searchTable?: string;
    searchKey?: string;
    responseVariable?: string;
  };

  // tag
  tagName?: string;
}

export interface FlowRecord {
  PK: string;
  SK: string;
  flowId: string;
  flowName: string;
  businessId: string;
  phoneNumberId: string;
  triggerKeywords: string[];
  triggerType: "keyword_match" | "any_reply" | "no_reply_timeout";
  steps: FlowStep[];
  status: "active" | "paused" | "draft";
  createdAt: string;
  updatedAt: string;
}

export interface FlowInstanceRecord {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  instanceId: string;
  flowId: string;
  phone: string;
  contactName: string;
  currentStepIndex: number;
  status: "running" | "waiting" | "completed" | "failed";
  waitUntil?: string;
  retriggerCount: number;
  maxRetriggers: number;
  stepResults: Record<string, unknown>[];
  variables: Record<string, string>;
  lastReply?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  phone: string;
  phoneNumberId: string;
  direction: "inbound" | "outbound";
  messageType: "text" | "template" | "image";
  content: string;
  metaMessageId: string;
  flowId?: string;
  contactName?: string;
  timestamp: string;
}
