import { PhoneNumber } from "../types";

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface SendParams {
  phone: string;
  contactName: string;
  templateName: string;
  parameters: string[];
  number: PhoneNumber;
}

export interface FetchedTemplate {
  name: string;
  language: string;
  category: string;
  status: string;
  components: unknown[];
}

export interface Provider {
  sendMessage(params: SendParams): Promise<SendResult>;
  fetchTemplates?(number: PhoneNumber): Promise<FetchedTemplate[]>;
}
