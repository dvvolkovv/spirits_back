/**
 * Сверка речи клипа Omni с репликами сценки: проглотил ли Omni реплику или
 * переврал её. Распознаёт SpeechKit (stt.ts), сравниваются слова.
 */

/** Доля слов реплик, которая должна прозвучать. Стартовая; окончательная подбирается на ролике-образце. */
export const MATCH_THRESHOLD = 0.6;

export function speechWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Доля слов реплик (с повторами), найденных в распознанном тексте. Реплик нет — 1. */
export function speechMatch(lines: string[], heard: string): number {
  const expected = lines.flatMap(speechWords);
  if (!expected.length) return 1;
  const pool = new Map<string, number>();
  for (const w of speechWords(heard)) pool.set(w, (pool.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of expected) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      hit++;
      pool.set(w, left - 1);
    }
  }
  return hit / expected.length;
}
