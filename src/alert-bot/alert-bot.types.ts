export interface AdminIdentity { userId: string | null; isAdmin: boolean; }
export interface TurnInput {
  updateId: number; chatId: string; tgUserId: string; adminUserId: string;
  questionMessageId: number; question: string; replyText?: string;
  parentTurnId?: string | null; ticketId?: string | null; privateChat: boolean;
  mode?: 'repair'; repairId?: string; recoverRepair?: boolean;
}
export interface RepairIdentity {
  scope: 'repair';
  adminUserId: string;
  adminTgId: string;
  chatId: string;
  turnId: string;
  repairId: string;
}
export interface OpsIdentity { scope: 'ops'; adminUserId: string; chatId: string; }
export type AlertBotTokenIdentity = OpsIdentity | RepairIdentity;
export interface OpsContext {
  adminUserId: string;
  chatId: string;
  scope?: 'ops' | 'repair';
  adminTgId?: string;
  turnId?: string;
  repairId?: string;
}
export interface RepairTurnInput extends TurnInput {
  mode: 'repair';
  repairId: string;
}
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
