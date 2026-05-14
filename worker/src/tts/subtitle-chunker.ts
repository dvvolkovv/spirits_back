// worker/src/tts/subtitle-chunker.ts
export interface SubtitleChunk {
  text: string;
  tStart: number;
  tEnd: number;
}

const MAX_WORDS_PER_CHUNK = 5;
const MIN_WORDS_PER_CHUNK = 2;

/**
 * Split `text` into subtitle chunks of ~3-5 words each, distributing the
 * total `tEnd - tStart` duration proportionally to chunk character length.
 *
 * Strategy:
 *   1. Split on sentence terminators (. ! ? …) keeping the terminator.
 *   2. For each sentence: if <= MAX_WORDS, keep whole; else greedy-split
 *      on word boundaries respecting MAX/MIN.
 *   3. Allocate time per chunk proportionally to character count.
 *
 * Pure function, no side effects.
 */
export function chunkSubtitles(text: string, tStart: number, tEnd: number): SubtitleChunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Split into sentences preserving terminators
  const sentences: string[] = [];
  let lastIdx = 0;
  const re = /([.!?…]+["»)]?)\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const end = m.index + m[1].length;
    sentences.push(trimmed.slice(lastIdx, end).trim());
    lastIdx = end;
  }
  if (lastIdx < trimmed.length) sentences.push(trimmed.slice(lastIdx).trim());

  // Break each sentence into word-chunks of MAX_WORDS, with the final tail
  // merged if it would be < MIN_WORDS
  const rawChunks: string[] = [];
  for (const s of sentences) {
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let i = 0;
    while (i < words.length) {
      let end = Math.min(i + MAX_WORDS_PER_CHUNK, words.length);
      if (end < words.length && words.length - end < MIN_WORDS_PER_CHUNK) {
        end = words.length;
      }
      rawChunks.push(words.slice(i, end).join(' '));
      i = end;
    }
  }
  if (rawChunks.length === 0) return [];

  // Distribute duration proportionally to character length
  const totalDur = tEnd - tStart;
  const totalChars = rawChunks.reduce((acc, c) => acc + c.length, 0);
  let cursor = tStart;
  const result: SubtitleChunk[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const c = rawChunks[i];
    const dur = (c.length / totalChars) * totalDur;
    const cStart = cursor;
    const cEnd = i === rawChunks.length - 1 ? tEnd : cursor + dur;
    result.push({ text: c, tStart: round(cStart), tEnd: round(cEnd) });
    cursor = cEnd;
  }
  return result;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
