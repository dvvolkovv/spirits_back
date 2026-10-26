/**
 * Сценки роликов: форма, промпты для Nano Banana и Omni, отпечаток.
 *
 * Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Кто пишет
 * сценки». Режиссёр и сценарист отдают сценку полями, а промпт собирает код:
 * так облик и голос героев одинаковы из ролика в ролик, а запреты (текст,
 * экраны, логотипы, дети) не забываются. Место и действие пишутся
 * по-английски — они идут прямо в промпт; реплики — по-русски.
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
  /** 2–3 героя; role — из ролей героя. */
  cast: { hero: TroupeId; role: string }[];
  setting: string;
  action: string;
  /** 1–3 реплики, всего до 25 слов. */
  lines: SkitLine[];
}

export interface SkitPlan {
  skit: Skit;
  troupeVersion: string;
  /** Чьи портреты нужны кадру — по порядку состава, без повторов. */
  heroes: TroupeId[];
  keyframePrompt: string;
  videoPrompt: string;
  fingerprint: string;
}

export const SKIT_STYLE =
  'Claymation stop-motion: handmade plasticine characters with visible fingerprints and clay texture, warm miniature set lighting.';
export const SKIT_FRAMING =
  'Tall vertical 9:16 phone frame. The picture fills the whole frame edge to edge: no borders, no letterbox bars, no split screen. The camera is close, the characters are big.';
export const SKIT_FORBIDDEN =
  'No text, letters, subtitles or logos anywhere. Any phone is seen from the back, its screen is not visible. No real people and no children.';

function castHeroes(skit: Skit): Hero[] {
  return skit.cast.map((c) => {
    const h = heroById(c.hero);
    if (!h) throw new Error(`skit: героя «${c.hero}» нет в труппе ${TROUPE_VERSION}`);
    return h;
  });
}

/** Кадр-эталон: начало сценки. У развязки — опора на кадр конфликта (последний из присланных портретов). */
export function buildKeyframePrompt(skit: Skit, o: { continuity: boolean }): string {
  const heroes = castHeroes(skit);
  const cast = skit.cast.map((c, i) => `${i + 1}) ${heroes[i].look}, playing «${c.role}»`).join('; ');
  return [
    SKIT_STYLE,
    `Keep every character exactly as in the reference portraits: ${cast}.`,
    `Exactly ${heroes.length} characters, each appears once.`,
    o.continuity ? 'Same place, costumes and lighting as in the last reference image (the previous scene).' : '',
    `Setting: ${skit.setting}.`,
    `The opening moment of the scene: ${skit.action}`,
    SKIT_FRAMING,
    SKIT_FORBIDDEN,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Клип: действие и реплики по порядку, каждая — с голосом говорящего из паспорта. */
export function buildVideoPrompt(skit: Skit): string {
  const cast = new Set(castHeroes(skit).map((h) => h.id));
  const said = skit.lines
    .map((l, i) => {
      const h = heroById(l.hero);
      if (!h || !cast.has(h.id)) throw new Error(`skit: «${l.hero}» говорит реплику, но не в составе сценки`);
      return `${i + 1}) ${h.who}, ${h.voice}: «${l.text}»`;
    })
    .join(' ');
  return [
    SKIT_STYLE,
    'Animate this image: keep the characters, the set and the lighting exactly as in it.',
    skit.action,
    `Dialogue in Russian, spoken clearly in this order, each line word for word: ${said}`,
    'Lips move with the speech. Slightly jerky stop-motion movement, small comic gestures, no camera cuts, no music.',
    SKIT_FORBIDDEN,
  ].join(' ');
}

/** Отпечаток — от версии труппы и обоих промптов: правка шаблона тоже переснимает сценку. */
export function skitFingerprint(p: Pick<SkitPlan, 'troupeVersion' | 'keyframePrompt' | 'videoPrompt'>): string {
  return createHash('sha256').update([p.troupeVersion, p.keyframePrompt, p.videoPrompt].join('\n')).digest('hex').slice(0, 16);
}

export function planSkit(skit: Skit, kind: SkitKind): SkitPlan {
  const keyframePrompt = buildKeyframePrompt(skit, { continuity: kind === 'punchline' });
  const videoPrompt = buildVideoPrompt(skit);
  const heroes = [...new Set(skit.cast.map((c) => c.hero))];
  return {
    skit,
    troupeVersion: TROUPE_VERSION,
    heroes,
    keyframePrompt,
    videoPrompt,
    fingerprint: skitFingerprint({ troupeVersion: TROUPE_VERSION, keyframePrompt, videoPrompt }),
  };
}
