import * as crypto from 'crypto';
import { telegramChatIds } from '../common/telegram-alert';

export const ALERT_BOT_HANDLER = Symbol('ALERT_BOT_HANDLER');
export function alertBotEnabled(): boolean {
  return Boolean(process.env.ALERT_BOT_WEBHOOK_URL && process.env.ALERT_BOT_WEBHOOK_SECRET);
}
export function validAlertBotSecret(header: string | string[] | undefined): boolean {
  const expected = process.env.ALERT_BOT_WEBHOOK_SECRET || '';
  if (!expected || typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
export const alertBotModel = () => process.env.ALERT_BOT_MODEL || process.env.CHAT_MODEL || 'claude-opus-5-5';
export const alertBotRatePerHour = () => intEnv('ALERT_BOT_RATE_PER_HOUR', 30, 1, 1000);
export const alertBotTimeoutMs = () => intEnv('ALERT_BOT_TIMEOUT_MS', 180000, 1000, 600000);
export const alertBotOpsPort = () => intEnv('ALERT_BOT_OPS_PORT', 3091, 1024, 65535);
export function alertBotAllowedChat(chatId: string, chatType: string): boolean {
  if (chatType === 'private') return true;
  return (chatType === 'group' || chatType === 'supergroup') && telegramChatIds().includes(String(chatId));
}
