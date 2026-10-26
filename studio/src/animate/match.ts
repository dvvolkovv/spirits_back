/**
 * Сверка речи клипа Omni с репликами сценки: проглотил ли Omni реплику или
 * переврал её. Распознаёт SpeechKit (stt.ts), сравниваются слова.
 */

/** Доля слов реплик, которая должна прозвучать. Стартовая; окончательная подбирается на ролике-образце. */
export const MATCH_THRESHOLD = 0.6;
/** Слово короче — междометие или предлог: по нему не судят, прозвучала ли реплика. */
const MIN_LINE_WORD = 3;

/**
 * Слова текста: NFC без знаков ударения, нижний регистр, «ё» → «е», без знаков
 * препинания. Дефис делит слово («Га-га» → «га», «га»). Порядок слов и лишние
 * слова при сверке не важны.
 */
export function speechWords(s: string): string[] {
  return s
    .normalize('NFC')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Сверяются только слова с кириллицей и гласной: числа SpeechKit пишет то
 * словами, то цифрами, латиницу («Linkeon») — по-своему, а «ш», «хм» — как
 * попало; пересъёмка этого не лечит.
 */
const checkable = (w: string): boolean => /\p{Script=Cyrillic}/u.test(w) && /[аеиоуыэюя]/u.test(w);
/** «А-а-а», «Га-га» — одно ожидаемое слово: SpeechKit пишет такие повторы как попало или не пишет вовсе. */
const collapse = (l: string): string => l.replace(/(\p{L}+)(?:-\1)+/giu, '$1');
/** Предложения реплики: обрыв в конце клипа съедает именно последнее. */
const sentences = (l: string): string[] => l.split(/(?<=[.!?…])\s+/u);

/** Слитное «гага» на месте «га-га» из реплик — повтор слога: так SpeechKit пишет междометия. */
function unglue(w: string, vocab: Set<string>): string[] {
  if (vocab.has(w)) return [w];
  for (let n = 2; n <= w.length / 2; n++) {
    const syl = w.slice(0, n);
    if (w.length % n === 0 && vocab.has(syl) && syl.repeat(w.length / n) === w) return Array<string>(w.length / n).fill(syl);
  }
  return [w];
}

export interface SpeechCheck {
  /** Клип годится: доля не ниже порога и ни одна реплика не проглочена. */
  ok: boolean;
  /** Доля сверяемых слов реплик (с повторами), найденных в распознанном. */
  share: number;
  /** Номера реплик (с 0), от которых — или от их последнего предложения — не услышано ни одного слова от трёх букв. */
  silentLines: number[];
}

export function speechCheck(lines: string[], heard: string): SpeechCheck {
  const words = (s: string): string[] => speechWords(collapse(s)).filter(checkable);
  const perLine = lines.map(words);
  const vocab = new Set(perLine.flat());
  const pool = new Map<string, number>();
  for (const w of speechWords(heard).flatMap((x) => unglue(x, vocab))) pool.set(w, (pool.get(w) ?? 0) + 1);
  const heardWords = new Set(pool.keys());
  const expected = perLine.flat();
  let hit = 0;
  for (const w of expected) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      hit++;
      pool.set(w, left - 1);
    }
  }
  const share = expected.length ? hit / expected.length : 1;
  const long = (s: string): string[] => words(s).filter((w) => w.length >= MIN_LINE_WORD);
  const silentLines = lines
    .map((l, i) => ({ i, parts: [long(l), long(sentences(l).at(-1) ?? '')] }))
    .filter(({ parts }) => parts.some((p) => p.length > 0 && !p.some((w) => heardWords.has(w))))
    .map(({ i }) => i);
  return { ok: share >= MATCH_THRESHOLD && silentLines.length === 0, share, silentLines };
}
