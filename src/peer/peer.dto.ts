export interface ChatRequestRow {
  id: string;
  from_user_id: string;
  to_user_id: string;
  intro_message: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  created_at: string;
  responded_at: string | null;
}

export interface PeerConversationRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  request_id: string | null;
  created_at: string;
  last_message_at: string | null;
}

export interface PeerMessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  read_at: string | null;
}

export interface CreateChatRequestDto {
  toUserId: string;
  introMessage: string;
}

export interface SendMessageDto {
  content: string;
}

export interface ReportUserDto {
  targetUserId: string;
  reason: string;
  contextType?: 'request' | 'message' | 'profile';
  contextId?: string;
}

export const LIMITS = {
  INTRO_MAX: 500,
  MESSAGE_MAX: 4000,
  MAX_PENDING_OUTGOING: 10,
  RATE_WINDOW_SEC: 3600,
  RATE_MAX_PER_WINDOW: 5,
};
