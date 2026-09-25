/** Реплика расшифровки: так её кладёт voice-host (форма проверена на проде). */
export interface TranscriptTurn {
  ts?: number;
  role?: string;
  text?: string;
}

export type CallFlag = 'interrupted' | 'failed' | 'live' | 'silent' | 'nearly_silent' | 'short';

/**
 * Статусы идущей сессии. Расшифровку voice-host дописывает по ходу
 * (VoiceCallService.progress), так что «молчал» и «почти молчал» считались бы
 * по недописанному разговору. Это пометка состояния, а не проблемы, — поэтому
 * в интерфейсе она нейтральная.
 */
const LIVE_STATUSES = new Set(['dialing', 'active']);

/** Меньше этого — «короткий»: на проде средний состоявшийся звонок 237 секунд. */
export const SHORT_CALL_SEC = 30;

/**
 * Сколько раз человек открыл рот.
 *
 * Терпит всё что угодно вместо массива: расшифровки нет у трети звонков, а
 * jsonb-колонка не гарантирует форму. Падать здесь нельзя — одна битая строка
 * уронила бы весь список звонков.
 */
export function countUserTurns(transcript: unknown): number {
  if (!Array.isArray(transcript)) return 0;
  return transcript.filter((t) => (t as TranscriptTurn)?.role === 'user').length;
}

/**
 * Пометки, по которым видно, какой разговор стоит открыть.
 *
 * Смысл именно в проблемных: на 05.09.2026 из 68 звонков 22 не состоялись, а
 * ещё в 15 человек не произнёс ни реплики. Удачные диалоги пометок не имеют —
 * их и незачем выделять, глазами их смотрят реже.
 */
export function callFlags(call: {
  status?: string;
  duration_sec?: number | null;
  transcript?: unknown;
}): CallFlag[] {
  // Прерванный — отдельный случай: длительности у него нет, а расшифровка, если
  // и есть, оборвана (voice-host пишет её по ходу — на стенде у 7 из 11
  // прерванных встреч она есть). «Молчал» по ней был бы неверен: пометка
  // должна говорить, что разговор оборвался.
  if (call.status === 'interrupted') return ['interrupted'];

  // Сорвавшаяся сессия: бот не вошёл, не подключился звук, оборвалась связь.
  // Реплик может не быть вовсе, но человек при этом не молчал. Причина — в
  // саммари («Звонок не состоялся: …», «Вход во встречу не состоялся: …»).
  // Если сбой пришёл раньше штатного завершения, complete() перепишет и
  // статус, и саммари: такая сессия останется completed с обычными пометками.
  if (call.status === 'failed') return ['failed'];
  if (call.status && LIVE_STATUSES.has(call.status)) return ['live'];

  const flags: CallFlag[] = [];
  const turns = countUserTurns(call.transcript);
  if (turns === 0) flags.push('silent');
  else if (turns <= 2) flags.push('nearly_silent');

  const dur = call.duration_sec ?? 0;
  if (dur > 0 && dur < SHORT_CALL_SEC) flags.push('short');

  return flags;
}
