export type TicketStatus = 'ai_handling' | 'escalated' | 'owner_handling' | 'resolved' | 'closed';
export type Urgency = 'low' | 'normal' | 'high' | 'critical';
export type SenderType = 'user' | 'ai' | 'owner' | 'system';

export interface SupportTicketRow {
  id: string;
  user_id: string;
  status: TicketStatus;
  urgency: Urgency | null;
  topic: string | null;
  escalation_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  resolved_at: string | null;
}

export interface SupportMessageRow {
  id: string;
  ticket_id: string;
  sender_type: SenderType;
  sender_id: string | null;
  content: string;
  metadata: any;
  visible_to_user: boolean;
  created_at: string;
}

export interface PostUserMessageDto {
  content: string;
}

export const LIMITS = {
  MESSAGE_MAX: 4000,
  RATE_MESSAGES_PER_10MIN: 30,
  AI_MAX_TURNS: 4,
  // AI self-refund safety limits.
  REFUND_MAX_PER_CALL: 10_000,
  REFUND_MAX_PER_TICKET: 20_000,
  REFUND_MAX_DAILY_PER_USER: 30_000,
};
