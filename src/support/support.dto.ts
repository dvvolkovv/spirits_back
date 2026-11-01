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

/**
 * Модель ИИ-поддержки. До 01.11.2026 стояла claude-haiku-4-5: разбор всех
 * тикетов показал, что она не открывает справку и придумывает разделы и кнопки
 * (раздел «Интеграции» у продуктов, которого нет), а «session limit» нашей
 * подписки объясняет вкладками и cookies. Обращений около одного в неделю,
 * поэтому цена Sonnet здесь не важна. Запрос идёт через бинарь, вложенный в
 * пакет Agent SDK, а не через системный claude: новую модель проверять им —
 * node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --print --model <id>.
 */
export const SUPPORT_MODEL = 'claude-sonnet-5';

export const LIMITS = {
  MESSAGE_MAX: 4000,
  RATE_MESSAGES_PER_10MIN: 30,
  // Справка обязательна перед каждым ответом о кнопках и разделах — это шаг;
  // при 4 ход «справка → задачи → статус → эскалация» не доходил до ответа, а
  // 15.08.2026 человек вместо ответа получил «временные проблемы со связью»
  // (Reached maximum number of turns (4)).
  AI_MAX_TURNS: 6,
  // AI self-refund safety limits.
  REFUND_MAX_PER_CALL: 10_000,
  REFUND_MAX_PER_TICKET: 20_000,
  REFUND_MAX_DAILY_PER_USER: 30_000,
};
