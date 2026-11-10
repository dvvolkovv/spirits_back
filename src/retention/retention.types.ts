export type RetentionMode = 'general' | 'curious';
export type RetentionChannel = 'email' | 'sms' | 'no_channel';

export interface RetentionContact {
  userId: string;
  email: string | null;
  phone: string | null;
  language: string;
  name: string | null;
  unsubscribed: boolean;
}

export interface RetentionDraft {
  user_id: string;
  phone: string | null;
  email: string | null;
  channel: RetentionChannel;
  language: string;
  subject: string | null;
  message: string;
  assistant_id?: string;
  assistant_name?: string | null;
  last_at: Date | string;
  days_inactive?: number;
  hours_inactive?: number;
  last_sent_at: Date | string | null;
  in_cooldown: boolean;
}

export interface RetentionSummary {
  email: number;
  sms: number;
  no_channel: number;
  skipped_unsubscribed: number;
}

export interface RetentionPreview {
  channel: 'mixed';
  campaign: string;
  window: { min_days?: number; max_days?: number; min_hours?: number; max_hours?: number };
  cooldown_days: number;
  count: number;
  summary: RetentionSummary;
  drafts: RetentionDraft[];
}

export interface RetentionSendRequest {
  confirm?: boolean;
  userIds?: string[];
  phones?: string[];
  resend?: boolean;
  minDays?: number;
  maxDays?: number;
}

export interface RetentionResultRow {
  user_id: string;
  phone: string | null;
  email: string | null;
  channel: Exclude<RetentionChannel, 'no_channel'>;
  status: 'sent' | 'failed';
  error: string | null;
  log_error?: boolean;
}

export interface RetentionSendResult {
  campaign: string;
  sent: number;
  sent_email: number;
  sent_sms: number;
  failed: number;
  skipped_cooldown: number;
  skipped_unsubscribed: number;
  no_channel: number;
  results: RetentionResultRow[];
}

export type RetentionSendResponse =
  | RetentionSendResult
  | { error: 'confirm_required' | 'ambiguous_recipient_filter' | 'invalid_recipient_filter'; message: string };
