import * as jwt from 'jsonwebtoken';
import { alertBotRepairTimeoutMs, alertBotTimeoutMs } from './alert-bot.config';
import { AlertBotTokenIdentity, RepairIdentity } from './alert-bot.types';

const secret = () => {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET required');
  return value;
};
const chatAndAdmin = (p: any) => typeof p.sub === 'string' && typeof p.chatId === 'string';

export function signOpsToken(adminUserId: string, chatId: string): string {
  const ttlSeconds = Math.max(600, Math.ceil(alertBotTimeoutMs() / 1000) + 120);
  return jwt.sign({ scope: 'ops', sub: adminUserId, chatId }, secret(), { expiresIn: ttlSeconds });
}
export function signRepairToken(input: Omit<RepairIdentity, 'scope'>): string {
  return jwt.sign({
    scope: 'repair', sub: input.adminUserId, adminTgId: input.adminTgId,
    chatId: input.chatId, turnId: input.turnId, repairId: input.repairId,
  }, secret(), { expiresIn: Math.ceil(alertBotRepairTimeoutMs() / 1000) + 120 });
}
export function verifyAlertBotToken(token: string): AlertBotTokenIdentity | null {
  try {
    const p = jwt.verify(token, secret()) as any;
    if (!chatAndAdmin(p)) return null;
    if (p.scope === 'ops') return { scope: 'ops', adminUserId: p.sub, chatId: p.chatId };
    if (p.scope === 'repair' && [p.adminTgId, p.turnId, p.repairId].every((v) => typeof v === 'string')) {
      return { scope: 'repair', adminUserId: p.sub, adminTgId: p.adminTgId, chatId: p.chatId, turnId: p.turnId, repairId: p.repairId };
    }
    return null;
  } catch { return null; }
}
export function verifyOpsToken(token: string): { adminUserId: string; chatId: string } | null {
  const identity = verifyAlertBotToken(token);
  return identity?.scope === 'ops' ? { adminUserId: identity.adminUserId, chatId: identity.chatId } : null;
}
