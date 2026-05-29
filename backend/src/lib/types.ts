// Shared backend types

export interface PhoneNumber {
  phoneNumberId: string;
  displayNumber: string;
  displayName: string;
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
  wabaId: string;
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
  campaignId: string;
  campaignName: string;
  businessId: string;
  businessName: string;
  selectedNumbers: PhoneNumber[];
  templateName: string;
  templateMappings: Record<string, string>;
  parameterMapping: Record<string, string>;
  csvS3Key: string;
  totalContacts: number;
  scheduleDate: string;
  scheduleTime: string;
  schedulerArn?: string;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
}
