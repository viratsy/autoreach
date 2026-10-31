// Shared backend types

export type Provider = "meta" | "aisensy" | "wati";

export interface PhoneNumber {
  phoneNumberId: string;
  displayNumber: string;
  displayName: string;
  wabaid?: string;
  apiKey?: string;
  source?: string;
  endpoint?: string;
  // Cached from the last businesses/quality-check.ts run — not live, refreshed
  // whenever someone checks quality from the UI. Absent until first checked.
  qualityRating?: string;
  messagingLimit?: string;
}

export interface CSVContact {
  phone: string;
  name?: string;
  [key: string]: string | undefined;
}

export interface BusinessRecord {
  PK: string;
  SK: string;
  businessId: string;
  businessName: string;
  provider?: Provider;
  accessToken: string;
  phoneNumbers: PhoneNumber[];
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRecord {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK: string;
  GSI2SK: string;
  // Sparse — only set on campaigns created by current-batch-scheduler.ts,
  // for its own idempotency check. Absent on every campaign created any
  // other way.
  GSI3PK?: string;
  campaignId: string;
  campaignName: string;
  businessId: string;
  businessName: string;
  selectedNumbers: PhoneNumber[];
  templateName: string;
  templateMappings: Record<string, string>;
  parameterMapping: Record<string, string>;
  csvS3Key: string;
  // Explicit building blocks for both the campaign name (workshop_batch_msg_id)
  // and Total Cost grouping (by workshop+batch) — kept as real fields rather
  // than parsed back out of campaignName, so grouping is exact by construction.
  workshop?: string;
  batch?: string;
  msg?: string;
  headerImageUrl?: string;
  numbersWithImageHeader?: string[];
  templateCategory?: string;
  failureMode?: string;
  autoRetry?: boolean;
  // Whether send-worker.ts should skip contacts on the STOP/unsubscribe list.
  // Undefined means true (existing campaigns predate this field and always
  // respected the list) — only an explicit false turns the check off.
  respectUnsubscribeList?: boolean;
  // Whether send-worker.ts should skip contacts already found in the
  // masterclass_lookup_key paid-users table. Same undefined-means-true
  // convention as respectUnsubscribeList.
  excludePaidUsers?: boolean;
  // Whether this campaign also emails its audience. Opt-IN, unlike the two
  // flags above: undefined means false, so enabling an email template can
  // never retroactively rope in campaigns that were scheduled before the
  // decision to start emailing.
  emailEnabled?: boolean;
  /** Which email template this campaign sends, chosen while setting it up. */
  emailTemplateId?: string;
  retryCount?: number;
  totalContacts: number;
  scheduleDate: string;
  scheduleTime: string;
  schedulerArn?: string;
  estimatedCost?: { perMessage: number; total: number; currency: string };
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Set once when the campaign actually starts sending (send.ts's "running"
  // transition) and once when it lands on "completed" for good — separate
  // from updatedAt (which keeps changing throughout the run) so "time taken"
  // can be computed without conflating the two.
  startedAt?: string;
  completedAt?: string;
  // Set once, on the ORIGINAL campaign, the first time it spawns a Retry-Failed
  // follow-up — doubles as an idempotency guard so a campaign never spawns two.
  retryFailedCampaignId?: string;
  // Set on the follow-up campaign itself, pointing back at the original — used to
  // stop a Retry-Failed campaign from spawning another Retry-Failed campaign.
  parentCampaignId?: string;
}

export interface MessageRecord {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  phoneNumber: string;
  contactName: string;
  sendingNumberId: string;
  metaMessageId: string;
  status: string;
  repliedAt: string | null;
  errorCode: string | null;
  sentAt: string;
  updatedAt: string;
  // Full original CSV row for this contact, captured at send time — lets a
  // failed message be retried (with every template parameter, not just
  // phone/name) straight from a Messages query, no need to re-fetch and
  // re-parse the whole source CSV. Absent on messages written before this
  // field existed.
  csvRow?: Record<string, string | undefined>;
}
