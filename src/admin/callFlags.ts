/** Реплика расшифровки: так её кладёт voice-host (форма проверена на проде). */
export interface TranscriptTurn {
  ts?: number;
  role?: string;
  text?: string;
}

export type CallFlag = 'interrupted' | 'silent' | 'nearly_silent' | 'short';

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
  // Прерванный — отдельный случай: у него нет ни длительности, ни расшифровки,
  // и остальные пометки посчитались бы как «молчал и короткий», что неверно:
  // человек не молчал, разговор просто не начался.
  if (call.status === 'interrupted') return ['interrupted'];

  const flags: CallFlag[] = [];
  const turns = countUserTurns(call.transcript);
  if (turns === 0) flags.push('silent');
  else if (turns <= 2) flags.push('nearly_silent');

  const dur = call.duration_sec ?? 0;
  if (dur > 0 && dur < SHORT_CALL_SEC) flags.push('short');

  return flags;
}
