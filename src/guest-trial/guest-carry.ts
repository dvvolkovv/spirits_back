import { GUEST_TRIAL_TTL_DAYS, GuestHistoryMessage } from './guest-trial.types';

/** Сколько пересказа пробы помещается в приписку: хвост разговора важнее начала. */
export const GUEST_CARRY_MAX_CHARS = 6000;

/** Те методы RedisService, что нужны приписке. */
export interface CarryStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export const guestCarryKey = (userId: string, assistantId: string): string => `guest-carry:${userId}:${assistantId}`;

/**
 * Пересказ пробы для хода через релей. Нужен только аккаунту, у которого с этим
 * ассистентом уже была сессия на релее: она возобновится (--resume) без пробы.
 * Новому аккаунту хватает хвоста истории, который релей вставляет сам.
 */
export function renderGuestCarry(msgs: GuestHistoryMessage[]): string {
  const lines = msgs.map((m) => `${m.sender_type === 'human' ? 'Человек' : 'Ты'}: ${m.content}`).join('\n\n');
  const body = lines.length > GUEST_CARRY_MAX_CHARS ? `…${lines.slice(-GUEST_CARRY_MAX_CHARS)}` : lines;
  return (
    `--- Разговор до входа ---\n` +
    `До входа в аккаунт человек говорил с тобой в пробном режиме. Это начало вашего разговора — продолжай его, не здоровайся заново:\n\n` +
    body
  );
}

export async function putGuestCarry(store: CarryStore, userId: string, assistantId: string, text: string): Promise<void> {
  await store.set(guestCarryKey(userId, assistantId), text, GUEST_TRIAL_TTL_DAYS * 24 * 60 * 60);
}

/** Забрать приписку: один раз — следующий ход её уже не получит. */
export async function takeGuestCarry(store: CarryStore, userId: string, assistantId: string): Promise<string | null> {
  const key = guestCarryKey(userId, assistantId);
  const value = await store.get(key);
  if (value) await store.del(key);
  return value || null;
}
