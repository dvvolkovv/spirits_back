/**
 * Сценки роликов: форма, промпты для Nano Banana и Omni, отпечатки.
 *
 * Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Кто пишет
 * сценки». Режиссёр и сценарист отдают сценку полями, а промпт собирает код:
 * так облик и голос героев одинаковы из ролика в ролик, а запреты (текст,
 * экраны, логотипы, дети) не забываются. Место, первый кадр и действие пишутся
 * по-английски — они идут прямо в промпты; реплики — по-русски. Роль героя в
 * промпты не идёт: русский текст в кавычках генератор картинок охотно рисует
 * надписью.
 *
 * Отпечатков два. Кадр-эталон студия хранит по отпечатку кадра, клип — по
 * отпечатку клипа, который включает отпечаток кадра. Кадр развязки рисуется по
 * кадру конфликта, поэтому его отпечаток включает отпечаток кадра конфликта:
 * новое место конфликта перерисует и развязку, а новая реплика переснимет
 * только клип своей сценки — с прежнего кадра.
 *
 * `SkitPlan` — то, что читает студия (зеркало studio/src/types.ts).
 */
import { createHash } from 'crypto';
import { Hero, heroById, TROUPE_VERSION, TroupeId } from './short-troupe';

export type SkitKind = 'conflict' | 'punchline';

export interface SkitLine {
  hero: TroupeId;
  /** По-русски, до 12 слов. */
  text: string;
  /** Абзац ответа, на который опирается утверждение по существу (только в развязке). */
  box?: number;
}

export interface Skit {
  /** 2–3 разных героя; role — из ролей героя, для режиссёра и сценариста. */
  cast: { hero: TroupeId; role: string }[];
  /** Место, одной фразой. */
  setting: string;
  /** Первый кадр: расстановка и позы до начала действия — по нему рисуется кадр-эталон. */
  opening: string;
  /** Что происходит за 8 секунд и визуальный гэг — по нему Omni оживляет кадр. */
  action: string;
  /** 1–3 реплики, всего до 25 слов. */
  lines: SkitLine[];
}

export interface SkitPlan {
  skit: Skit;
  troupeVersion: string;
  /** Чьи портреты нужны кадру — в порядке состава. */
  heroes: TroupeId[];
  keyframePrompt: string;
  videoPrompt: string;
  /** Отпечаток кадра-эталона: по нему студия хранит и переиспользует кадр. */
  keyframeFingerprint: string;
  /** Отпечаток клипа: отпечаток кадра и промпт видео. Клип с тем же отпечатком не переснимается. */
  fingerprint: string;
}

export const SKIT_STYLE =
  'Claymation stop-motion: handmade plasticine characters with visible fingerprints and clay texture, warm miniature set lighting.';
export const SKIT_FRAMING = [
  'Tall vertical 9:16 phone frame.',
  'The picture fills the whole frame edge to edge: no borders, no letterbox bars, no blurred bands, no split screen, no picture-in-picture; the wall continues above and the floor below all the way to the edges.',
  'The characters are big, their faces in the middle of the frame, between a third and three fifths of its height: the top third is calm background, and the lower part shows only bodies, floor and props — titles go there.',
].join(' ');
export const SKIT_FORBIDDEN =
  'No text, letters, subtitles or logos anywhere. Any phone, monitor or TV is turned away, its screen is not visible. No real people and no children.';

/** Пробелы схлопнуты: лишний пробел от модели не должен менять отпечаток — пересъёмка стоит денег. */
const clean = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Фраза с точкой в конце — модель пишет то с точкой, то без. */
const sentence = (s: string): string => {
  const t = clean(s);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/** Правило 17 спеки: реплика — до 12 слов, сценка — до 25. Длиннее Omni не уложит в 8 с, и сверка речи забракует оплаченный клип. */
export const MAX_SKIT_LINE_WORDS = 12;
export const MAX_SKIT_WORDS = 25;
/** Слово — токен с буквой или цифрой, как в short-rules.ts: тире между словами не слово. */
const wordCount = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Поля сценки проверяются до промптов: опечатка в имени поля дала бы «undefined»
 * в платном промпте, а сценарий проверяется только на сборке — после трат.
 * Место, первый кадр и действие — английские строки без кавычек: русский текст
 * и текст в кавычках генератор картинок охотно рисует надписью.
 */
function assertSkit(skit: Skit): void {
  if (!skit || typeof skit !== 'object') throw new Error('нет сценки');
  for (const f of ['setting', 'opening', 'action'] as const) {
    const v: unknown = skit[f];
    if (v == null || (typeof v === 'string' && !clean(v))) throw new Error(`пустое поле ${f}`);
    if (typeof v !== 'string') throw new Error(`поле ${f} — не строка`);
    if (/[а-яё«»"“”„]/i.test(skit[f])) throw new Error(`поле ${f} — по-английски и без кавычек: оно идёт прямо в промпт генератора`);
  }
  if (!Array.isArray(skit.cast) || skit.cast.length < 2 || skit.cast.length > 3) throw new Error('в составе нужно 2–3 героя');
  for (const c of skit.cast) if (typeof c?.role !== 'string' || !clean(c.role)) throw new Error(`у героя ${c?.hero} нет роли`);
  if (!Array.isArray(skit.lines) || skit.lines.length < 1 || skit.lines.length > 3) throw new Error('нужно 1–3 реплики');
  skit.lines.forEach((l, i) => {
    if (typeof l?.text !== 'string' || !clean(l.text)) throw new Error(`пустая реплика ${i + 1} (${l?.hero})`);
    if (wordCount(l.text) > MAX_SKIT_LINE_WORDS) throw new Error(`реплика ${i + 1} длиннее ${MAX_SKIT_LINE_WORDS} слов — Omni не уложит её в 8 с`);
  });
  const total = skit.lines.reduce((n, l) => n + wordCount(l.text), 0);
  if (total > MAX_SKIT_WORDS) throw new Error(`в репликах ${total} слов, больше ${MAX_SKIT_WORDS} — Omni не уложит их в 8 с`);
}

function castHeroes(skit: Skit): Hero[] {
  if (!skit.cast?.length) throw new Error('в сценке нет героев');
  const seen = new Set<string>();
  return skit.cast.map((c) => {
    const h = heroById(c.hero);
    if (!h) throw new Error(`героя «${c.hero}» нет в труппе ${TROUPE_VERSION}`);
    if (seen.has(h.id)) throw new Error(`«${c.hero}» дважды в составе сценки`);
    seen.add(h.id);
    return h;
  });
}

/**
 * Кадр-эталон: первый кадр сценки. Картинки уходят в генератор так: портреты
 * героев в порядке состава, у развязки последней — кадр конфликта.
 */
export function buildKeyframePrompt(skit: Skit, o: { continuity: boolean }): string {
  assertSkit(skit);
  const heroes = castHeroes(skit);
  const cast = heroes.map((h, i) => `${i + 1}) ${h.look}`).join('; ');
  return [
    SKIT_STYLE,
    `The first ${heroes.length} images are portraits of the characters, in this order: ${cast}. Keep each character's look exactly as in the portrait; poses follow the scene.`,
    o.continuity
      ? 'The last image is the previous scene: keep the same costumes and lighting, and the same place unless the setting below says otherwise.'
      : '',
    `Exactly ${heroes.length} characters — ${heroes.map((h) => h.who).join(' and ')} — each appears once.`,
    sentence(`Setting: ${skit.setting}`),
    sentence(`The picture: ${skit.opening}`),
    SKIT_FRAMING,
    SKIT_FORBIDDEN,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Клип: действие и реплики по порядку, у каждой — кто говорит и каким голосом (из паспорта). */
export function buildVideoPrompt(skit: Skit): string {
  assertSkit(skit);
  const cast = new Set(castHeroes(skit).map((h) => h.id));
  const said = skit.lines
    .map((l, i) => {
      const h = heroById(l.hero);
      if (!h || !cast.has(h.id)) throw new Error(`«${l.hero}» говорит реплику, но не в составе сценки`);
      return `${i + 1}) ${h.who} (${h.voice}) says in Russian: «${clean(l.text)}»`;
    })
    .join(' ');
  return [
    SKIT_STYLE,
    'Animate this image: keep the characters, the set and the lighting exactly as in it.',
    sentence(skit.action),
    `Dialogue, spoken clearly in this order, each line word for word: ${said}`,
    'The first line starts right away. Only the speaker talks, the others listen; mouths and beaks move with the speech.',
    'Slightly jerky stop-motion movement, small comic gestures, no camera cuts, no music.',
    SKIT_FORBIDDEN,
  ].join(' ');
}

const hash16 = (parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/** Отпечатки сценки. У развязки в отпечаток кадра входит отпечаток кадра конфликта. */
export function skitFingerprints(p: {
  kind: SkitKind;
  troupeVersion: string;
  keyframePrompt: string;
  videoPrompt: string;
  conflictKeyframe?: string;
}): { keyframeFingerprint: string; fingerprint: string } {
  const keyframeFingerprint = hash16([p.kind, p.troupeVersion, p.keyframePrompt, p.conflictKeyframe ?? '']);
  return { keyframeFingerprint, fingerprint: hash16([keyframeFingerprint, p.videoPrompt]) };
}

/** Одна сценка. Развязке нужен отпечаток кадра конфликта — пару планирует planSkits. Ошибки — с именем сценки. */
export function planSkit(skit: Skit, kind: SkitKind, conflictKeyframe?: string): SkitPlan {
  if (kind === 'punchline' && !conflictKeyframe) {
    throw new Error('сценка punchline: развязка рисуется по кадру конфликта — планируйте пару через planSkits');
  }
  if (kind === 'conflict' && conflictKeyframe) throw new Error('сценка conflict: отпечаток кадра конфликта передаётся только развязке');
  try {
    const keyframePrompt = buildKeyframePrompt(skit, { continuity: kind === 'punchline' });
    const videoPrompt = buildVideoPrompt(skit);
    return {
      skit,
      troupeVersion: TROUPE_VERSION,
      heroes: skit.cast.map((c) => c.hero),
      keyframePrompt,
      videoPrompt,
      ...skitFingerprints({ kind, troupeVersion: TROUPE_VERSION, keyframePrompt, videoPrompt, conflictKeyframe }),
    };
  } catch (e) {
    throw new Error(`сценка ${kind}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function planSkits(s: Record<SkitKind, Skit>): Record<SkitKind, SkitPlan> {
  const conflict = planSkit(s.conflict, 'conflict');
  return { conflict, punchline: planSkit(s.punchline, 'punchline', conflict.keyframeFingerprint) };
}
