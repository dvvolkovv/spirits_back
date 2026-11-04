export interface AdminIdentity { userId: string | null; isAdmin: boolean; }
export interface TurnInput {
  updateId: number; chatId: string; tgUserId: string; adminUserId: string;
  questionMessageId: number; question: string; replyText?: string;
  parentTurnId?: string | null; ticketId?: string | null; privateChat: boolean;
}
export interface OpsContext { adminUserId: string; chatId: string; }
export interface OpsToolHandler {
  definitions(): Array<Record<string, unknown>>;
  execute(name: string, args: Record<string, unknown>, ctx: OpsContext, signal?: AbortSignal): Promise<string>;
}
export interface TgMessage {
  message_id: number; text?: string; caption?: string;
  chat: { id: number | string; type: string };
  from?: { id: number | string; is_bot?: boolean; username?: string; first_name?: string };
  reply_to_message?: TgMessage;
}
