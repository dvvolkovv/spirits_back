import * as jwt from 'jsonwebtoken';

export function signOpsToken(adminUserId: string, chatId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET required');
  return jwt.sign({ scope: 'ops', sub: adminUserId, chatId }, secret, { expiresIn: '10m' });
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
