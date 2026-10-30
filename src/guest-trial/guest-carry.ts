import { neutralizeRoleMarkers } from './guest-prompt';
import { GUEST_CARRY_TTL_SECONDS, GuestHistoryMessage } from './guest-trial.types';

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
 * Обезвреживает метки роли в начале строки текста гостя — как
 * neutralizeRoleMarkers (guest-prompt.ts) для USER:/ASSISTANT:, но здесь ещё
 * и для формата самой приписки: «Человек:»/«Ты:». Приписка уходит в сессию
 * релея с инструментами: строка гостя, начинающаяся с этих слов, иначе
 * читалась бы моделью как настоящая реплика разговора. В guest_trial_messages
 * исходный текст не трогаем — обезвреживается только копия для приписки.
 */
function neutralizeCarryMarkers(s: string): string {
  return neutralizeRoleMarkers(s).replace(/^([ \t]*)(Человек|Ты)([ \t]*):/gim, '$1($2)$3:');
}

const roleLabel = (m: GuestHistoryMessage): string => (m.sender_type === 'human' ? 'Человек' : 'Ты');

/** Реплика целиком: метка роли + обезвреженный текст, без ограничения длины. */
const fullLine = (m: GuestHistoryMessage): string => `${roleLabel(m)}: ${neutralizeCarryMarkers(m.content)}`;

/** Та же реплика, но обрезанная спереди («…» + хвост), чтобы влезть в limit целиком. */
function truncatedLine(m: GuestHistoryMessage, limit: number): string {
  const prefix = `${roleLabel(m)}: `;
  const content = neutralizeCarryMarkers(m.content);
  const budget = Math.max(0, limit - prefix.length - 1);
  return `${prefix}…${content.slice(content.length - budget)}`;
}

/**
 * Пересказ пробы для хода через релей. Нужен аккаунту, у которого с этим
 * ассистентом уже была сессия на релее: она возобновится (--resume) без
 * пробы, если не оставить приписку. Новому аккаунту лишняя приписка не
 * вредит — это безвредный дубль хвоста истории, который релей и так
 * вставляет сам.
 *
 * Режется по целым репликам, а не по символам всей строки: самые ранние
 * сообщения отбрасываются целиком, пока тело не уложится в
 * GUEST_CARRY_MAX_CHARS. Если не влезает даже одна последняя реплика —
 * обрезаем только её начало («…» + хвост); соседей рядом с ней уже не берём —
 * места нет.
 */
export function renderGuestCarry(msgs: GuestHistoryMessage[]): string {
  const kept: string[] = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const line = fullLine(msgs[i]);
    const sep = kept.length > 0 ? 2 : 0;
    if (line.length + sep + total <= GUEST_CARRY_MAX_CHARS) {
      kept.unshift(line);
      total += line.length + sep;
      continue;
    }
    // Эта реплика (и, значит, всё, что раньше неё) не влезает рядом с уже
    // отобранным хвостом. Если хвост пока пуст — это самая последняя реплика
    // целиком длиннее лимита: берём только её, обрезав начало.
    if (kept.length === 0) kept.push(truncatedLine(msgs[i], GUEST_CARRY_MAX_CHARS));
    break;
  }
  const body = kept.join('\n\n');
  return (
    `--- Разговор до входа ---\n` +
    `До входа в аккаунт человек говорил с тобой в пробном режиме. Это начало вашего разговора — продолжай его, не здоровайся заново:\n\n` +
    body
  );
}

export async function putGuestCarry(store: CarryStore, userId: string, assistantId: string, text: string): Promise<void> {
  await store.set(guestCarryKey(userId, assistantId), text, GUEST_CARRY_TTL_SECONDS);
}

/**
 * Забрать приписку: один раз — следующий ход её уже не получит.
 *
 * get+del не атомарны (для этого нужен был бы отдельный GETDEL или EVAL), и
 * это осознанно: два одновременных первых хода к одному ассистенту
 * теоретически могут оба успеть прочитать приписку до чьего-то del — тогда
 * оба получат один и тот же пересказ. Не страшно: релей увидит дубль
 * контекста в начале сессии, а не потеряет и не перепутает её. Атомарный
 * GETDEL ради этого не делаем.
 */
export async function takeGuestCarry(store: CarryStore, userId: string, assistantId: string): Promise<string | null> {
  const key = guestCarryKey(userId, assistantId);
  const value = await store.get(key);
  if (value) await store.del(key);
  return value || null;
}
