export const MAX_CHUNK_CHARS = 42;

/**
 * Режет реплику на куски для субтитров по словам, не длиннее maxChars.
 * Слово длиннее предела идёт отдельным куском целиком: рвать слово хуже,
 * чем чуть вылезти за предел.
 */
export function splitCaption(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || next.length <= maxChars) {
      cur = next;
    } else {
      chunks.push(cur);
      cur = w;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface CaptionCue {
  text: string;
  from: number;
  duration: number;
}

/**
 * Делит кадры реплики между кусками пропорционально длине: длинный кусок
 * голос читает дольше. Каждому следующему куску остаётся хотя бы кадр,
 * последний забирает остаток от округления. Если кадров меньше, чем
 * кусков, реплика показывается одним куском.
 */
export function captionCues(chunks: string[], from: number, duration: number): CaptionCue[] {
  if (chunks.length === 0) return [];
  if (duration < chunks.length) return [{ text: chunks.join(' '), from, duration }];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const cues: CaptionCue[] = [];
  let cursor = from;
  chunks.forEach((text, i) => {
    const left = from + duration - cursor;
    const reserve = chunks.length - i - 1;
    const share = Math.max(1, Math.round((duration * text.length) / total));
    const d = i === chunks.length - 1 ? left : Math.min(left - reserve, share);
    cues.push({ text, from: cursor, duration: d });
    cursor += d;
  });
  return cues;
}
