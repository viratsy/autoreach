// Business types
export interface PhoneNumber {
  phoneNumberId: string;
  displayNumber: string;
  displayName: string;
  wabaid: string;
}

export interface Business {
  businessId: string;
  businessName: string;
  metaBusinessId?: string;
  phoneNumbers: PhoneNumber[];
  createdAt: string;
  updatedAt: string;
}

// Campaign types
export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TemplateMapping {
  [phoneNumberId: string]: string;
}

export interface ParameterMapping {
  [paramIndex: string]: string;
}

export interface Campaign {
  campaignId: string;
  campaignName: string;
  businessId: string;
  businessName: string;
  selectedNumbers: PhoneNumber[];
  templateName: string;
  templateMappings: TemplateMapping;
  parameterMapping: ParameterMapping;
  csvS3Key: string;
  totalContacts: number;
  scheduleDate: string;
  scheduleTime: string;
  status: CampaignStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  metrics?: CampaignMetrics;
}

export interface CampaignMetrics {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replies: number;
}

// Message types
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";

export interface Message {
  campaignId: string;
  phoneNumber: string;
  contactName: string;
  sendingNumberId: string;
  metaMessageId: string;
  status: MessageStatus;
  repliedAt: string | null;
  errorCode: string | null;
  sentAt: string;
  updatedAt: string;
}

// Template types
export interface Template {
  templateName: string;
  language: string;
  category: string;
  components: TemplateComponent[];
  parameterCount: number;
  status: "approved" | "pending" | "rejected";
  lastSyncedAt: string;
}

export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  text?: string;
  parameters?: TemplateParameter[];
}

export interface TemplateParameter {
  type: string;
  text?: string;
}

// CSV types
export interface CSVContact {
  phone: string;
  name?: string;
  [key: string]: string | undefined;
}

export interface CSVValidationResult {
  valid: boolean;
  totalRows: number;
  validRows: number;
  invalidRows: { row: number; phone: string; reason: string }[];
  headers: string[];
  preview: CSVContact[];
}

// Dashboard types
export interface DashboardStats {
  totalCampaigns: number;
  scheduled: number;
  running: number;
  completed: number;
  failed: number;
}
