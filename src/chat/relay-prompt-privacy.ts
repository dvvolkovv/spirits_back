/**
 * Точные блоки, добавленные в системный промпт из профиля пользователя.
 * При отзыве automaticProfiling удаляем только их, не затрагивая персону,
 * задачи и остальной контекст ассистента.
 */
export interface RelayProfilingInsertion {
  /** Позиция фактической вставки builder в исходном промпте. */
  start: number;
  /** Текст нужен для проверки, что диапазон всё ещё указывает на ту же вставку. */
  text: string;
}

export interface RelayProfilingBlocks {
  personal?: RelayProfilingInsertion;
  business?: RelayProfilingInsertion;
}

export function relayProfilingInsertion(prompt: string, start: number): RelayProfilingInsertion {
  return { start, text: prompt.slice(start) };
}

export function stripRelayProfilingBlocks(
  prompt: string,
  blocks: RelayProfilingBlocks,
): string {
  let sanitized = prompt;
  const insertions = [blocks.personal, blocks.business]
    .filter((block): block is RelayProfilingInsertion => !!block)
    // Позиции записаны в исходном промпте. Удаление с конца не сдвигает
    // диапазон следующего блока; повторный strip уже очищенного промпта — no-op.
    .sort((a, b) => b.start - a.start);
  for (const block of insertions) {
    const end = block.start + block.text.length;
    if (sanitized.slice(block.start, end) !== block.text) continue;
    sanitized = sanitized.slice(0, block.start) + sanitized.slice(end);
  }
  return sanitized;
}

/**
 * Отключённый profiling не должен возобновлять сессию, где профиль уже был в
 * контексте. При повторном разрешении исходный ключ остаётся прежним.
 */
export function relaySessionForProfiling(baseSessionId: string, allowed: boolean): string {
  return allowed ? baseSessionId : `${baseSessionId}_noprofiling`;
}
