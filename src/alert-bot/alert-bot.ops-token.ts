import * as jwt from 'jsonwebtoken';
import { alertBotTimeoutMs } from './alert-bot.config';

export function signOpsToken(adminUserId: string, chatId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET required');
  const ttlSeconds = Math.max(600, Math.ceil(alertBotTimeoutMs() / 1000) + 120);
  return jwt.sign({ scope: 'ops', sub: adminUserId, chatId }, secret, { expiresIn: ttlSeconds });
}
export function verifyOpsToken(token: string): { adminUserId: string; chatId: string } | null {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const p = jwt.verify(token, secret) as any;
    if (p.scope !== 'ops' || typeof p.sub !== 'string' || typeof p.chatId !== 'string') return null;
    return { adminUserId: p.sub, chatId: p.chatId };
  } catch { return null; }
}
