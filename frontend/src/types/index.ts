// Business types
export type Provider = "meta" | "aisensy" | "wati";

export interface PhoneNumber {
  phoneNumberId: string;
  displayNumber: string;
  displayName: string;
  wabaid?: string;
  apiKey?: string;
  source?: string;
  endpoint?: string;
  hasApiKey?: boolean; // read-only, from GET /businesses — apiKey itself is never sent to the browser
  // Cached from the last "Fetch Quality Rating" run — may be stale or absent.
  qualityRating?: string;
  messagingLimit?: string;
}

export interface Business {
  businessId: string;
  businessName: string;
  metaBusinessId?: string;
  provider?: Provider;
  accessToken?: string;
  hasAccessToken?: boolean; // read-only, from GET /businesses
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
  templateCategory?: string;
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
  // Present on GET /campaigns (the list endpoint) as of the dashboard redesign
  // — lets Recent Campaigns show real delivery % without a per-campaign fetch.
  sentCount?: number;
  deliveredCount?: number;
  readCount?: number;
  repliedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  estimatedCost?: { perMessage: number; total: number; currency: string } | null;
  actualCost?: { perMessage: number; total: number; currency: string };
  // Present on GET /campaigns — audience filters and sender count, for the list's row chips.
  respectUnsubscribeList?: boolean;
  excludePaidUsers?: boolean;
  numberCount?: number;
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
  source?: Provider;
  manuallyAdded?: boolean;
}

export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  text?: string;
  parameters?: TemplateParameter[];
  // HEADER-only: what kind of header this is. Already stored raw from Meta's
  // template API (see backend/src/handlers/templates/create.ts) — just not
  // typed/rendered client-side until the template preview feature.
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  // BUTTONS-only.
  buttons?: TemplateButton[];
}

export interface TemplateButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | string;
  text: string;
  url?: string;
  phone_number?: string;
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
export type WindowKey = "today" | "last7Days" | "last15Days" | "last30Days";

export interface MessageVolumeWindow {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}

export interface DailyBreakdownPoint {
  date: string; // YYYY-MM-DD, IST
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}

export interface TopTemplateStat {
  templateName: string;
  campaignCount: number;
  totalContacts: number;
  delivered: number;
  deliveryRate: number; // 0-1
}

export interface DashboardStats {
  totalCampaigns: number;
  scheduled: number;
  running: number;
  completed: number;
  failed: number;
  // All computed server-side in one pass over the same Scan, for all four
  // windows at once — so the dashboard's pill selector can switch between
  // them instantly with no extra request. Absent on older cached responses,
  // so always optional-chain/default these.
  messageVolume?: Record<WindowKey, MessageVolumeWindow>;
  // The equivalent preceding period for each window (e.g. last7Days' previous
  // period = the 7 days before that) — powers the "vs previous period" trend
  // arrows on the hero stat cards.
  previousMessageVolume?: Record<WindowKey, MessageVolumeWindow>;
  // Extra sums (failed/skipped/totalContacts) the message-breakdown donut
  // needs, on top of MessageVolumeWindow's sent/delivered/read/replied.
  breakdownTotals?: Record<WindowKey, MessageVolumeWindow & { failed: number; skipped: number; totalContacts: number }>;
  // Each campaign's lifetime counters bucketed onto its creation day (IST) —
  // an approximation (a multi-day campaign's whole volume lands on one day),
  // not true per-day message activity, since there's no date index on the
  // Messages table. Real data, just coarser granularity than a live feed.
  dailyBreakdown?: Record<WindowKey, DailyBreakdownPoint[]>;
  topTemplates?: Record<WindowKey, TopTemplateStat[]>;
}
