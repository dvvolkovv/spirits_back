/**
 * Сверка речи клипа Omni с репликами сценки: проглотил ли Omni реплику или
 * переврал её. Распознаёт SpeechKit (stt.ts), сравниваются слова — с точностью
 * до окончания (sameWord).
 */

/** Доля слов реплик, которая должна прозвучать. Стартовая; окончательная подбирается на ролике-образце. */
export const MATCH_THRESHOLD = 0.6;
/** Слово короче — междометие или предлог: по нему не судят, прозвучала ли реплика. */
const MIN_LINE_WORD = 3;
/** Последнее предложение судится по словам от четырёх букв: «Ага!», «Ого!», «Кря!» в конце реплики SpeechKit пишет как попало. */
const MIN_LAST_WORD = 4;
/**
 * Версия сверки — поднимать при любой правке её логики. Брак, отвергнутый
 * прежней версией, студия перепроверяет до новой оплаты (run-animate.ts,
 * reviveRejected). 2 — слова сравниваются с точностью до окончания (31.10.2026).
 */
export const MATCHER_VERSION = 2;
/** Общее начало от стольких букв — одно слово: SpeechKit путает окончания и сливает короткое слово с соседним. */
const STEM_MIN = 5;
/** Сколько букв меньшего слова может остаться за общим началом: «начинай» ≈ «начинаешь» (общее «начина» — 6 из 7). */
const STEM_SLACK = 2;
/** «Ааа», «Оооо» — крик, а не слово. */
const shout = (w: string): boolean => /^(\p{L})\1+$/u.test(w);

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
/**
 * «А-а-а», «Га-га» — одно ожидаемое слово: SpeechKit пишет такие повторы как
 * попало или не пишет вовсе. Через дефис, тире или неразрывный дефис (\p{Pd}).
 */
const collapse = (l: string): string => l.replace(/(\p{L}+)(?:\p{Pd}\1)+/giu, '$1');
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

/**
 * Одно ли это слово с точностью до окончания: равны или у них общее начало от
 * STEM_MIN букв, а меньшему слову до него не хватает не больше STEM_SLACK букв.
 * «начинай» ≈ «начинаешь» (SpeechKit слил «начинай уж», ролик 889b6423),
 * «убедил» ≈ «убедила»; «начинай» ≠ «начальник», «отказаться» ≠ «отказник».
 * Короткие слова — только точно.
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[n] === b[n]) n++;
  return n >= STEM_MIN && n >= max - STEM_SLACK;
}

export interface SpeechCheck {
  /** Клип годится: доля не ниже порога и ни одна реплика не проглочена. */
  ok: boolean;
  /** Доля сверяемых слов реплик (с повторами), найденных в распознанном с точностью до окончания. */
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
  const heardWords = [...pool.keys()];
  const expected = perLine.flat();
  // Сначала точные пары, потом с точностью до окончания: иначе неточное слово
  // могло бы забрать пару, которая точно подходит другому.
  const matched = expected.map(() => false);
  const take = (i: number, h: string): void => {
    matched[i] = true;
    pool.set(h, (pool.get(h) ?? 0) - 1);
  };
  expected.forEach((w, i) => {
    if ((pool.get(w) ?? 0) > 0) take(i, w);
  });
  expected.forEach((w, i) => {
    if (matched[i]) return;
    const h = heardWords.find((x) => (pool.get(x) ?? 0) > 0 && sameWord(w, x));
    if (h !== undefined) take(i, h);
  });
  const hit = matched.filter(Boolean).length;
  const share = expected.length ? hit / expected.length : 1;
  const long = (s: string, min = MIN_LINE_WORD): string[] => words(s).filter((w) => w.length >= min && !shout(w));
  const heardAny = (w: string): boolean => heardWords.some((h) => sameWord(w, h));
  // Реплика проглочена, если от неё не услышано ни одного слова; при нескольких
  // предложениях — и если не услышано ни одного слова последнего (обрыв клипа).
  const silentLines = lines
    .map((l, i) => {
      const s = sentences(l);
      return { i, parts: s.length > 1 ? [long(l), long(s.at(-1) ?? '', MIN_LAST_WORD)] : [long(l)] };
    })
    .filter(({ parts }) => parts.some((p) => p.length > 0 && !p.some(heardAny)))
    .map(({ i }) => i);
  return { ok: share >= MATCH_THRESHOLD && silentLines.length === 0, share, silentLines };
}
