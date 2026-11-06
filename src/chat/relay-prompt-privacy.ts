/**
 * Точные блоки, добавленные в системный промпт из профиля пользователя.
 * При отзыве automaticProfiling удаляем только их, не затрагивая персону,
 * задачи и остальной контекст ассистента.
 */
export interface RelayProfilingBlocks {
  personal?: string;
  business?: string;
}

export function stripRelayProfilingBlocks(
  prompt: string,
  blocks: RelayProfilingBlocks,
): string {
  let sanitized = prompt;
  for (const block of [blocks.personal, blocks.business]) {
    if (!block) continue;
    const at = sanitized.indexOf(block);
    if (at >= 0) sanitized = sanitized.slice(0, at) + sanitized.slice(at + block.length);
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
