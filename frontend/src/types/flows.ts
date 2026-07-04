export interface FlowBranch {
  keywords: string[];
  nextStepId: string;
}

export interface FlowStep {
  id: string;
  type: "send_message" | "wait_for_reply" | "wait" | "condition" | "api_call" | "tag" | "end";
  templateName?: string;
  messageText?: string;
  parameterMapping?: Record<string, string>;
  // wait_for_reply
  replyMessage?: string;
  replyTemplateName?: string;
  replyButtons?: string[];
  replyImageUrl?: string;
  replyVideoUrl?: string;
  branches?: FlowBranch[];
  defaultNextStepId?: string;
  timeoutHours?: number;
  timeoutAction?: "end" | "retry" | "goto";
  timeoutRetryMessage?: string;
  timeoutMaxRetries?: number;
  timeoutNextStepId?: string;
  // wait
  waitHours?: number;
  retriggerOnNoReply?: boolean;
  retriggerMessage?: string;
  maxRetriggers?: number;
  conditionType?: "keyword" | "any_reply" | "no_reply" | "variable_check";
  keywords?: string[];
  thenStepId?: string;
  elseStepId?: string;
  conditionVariable?: string;
  conditionOperator?: "contains" | "equals" | "not_equals" | "not_contains";
  conditionValue?: string;
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
  tagName?: string;
}

export interface Flow {
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

export interface FlowInstance {
  instanceId: string;
  flowId: string;
  phone: string;
  contactName: string;
  currentStepIndex: number;
  status: "running" | "waiting" | "completed" | "failed";
  waitUntil?: string;
  retriggerCount: number;
  startedAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
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

export interface ConversationContact {
  phone: string;
  name?: string;
  lastMessage: string;
  lastDirection: "inbound" | "outbound";
  lastTimestamp: string;
  phoneNumberId: string;
  attributes?: Record<string, string>;
}
