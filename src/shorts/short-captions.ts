import { LinkPlatform } from './short-links';
import { SKIT_KINDS, SkitKind, SkitPlan } from './short-skit-prompts';
import { heroById } from './short-troupe';
import { ANGLE_TITLES, RUBRIC_TITLES, ShortAnimation, ShortAngle, ShortCaptions, ShortRubric } from './shorts.types';

/**
 * Цены для подписи владельцу (прайс Google на 26.10.2026): секунда Omni при
 * 720p и кадр Nano Banana Pro. Те же числа печатает студия (studio/src/animate/google.ts).
 */
export const OMNI_USD_PER_SEC = 0.1;
export const KEYFRAME_USD = 0.13;

/** Telegram молча обрезает подпись длиннее — на этом обжигались с блогом. */
export const TG_CAPTION_MAX = 1000;
export const VK_TEXT_MAX = 2000;
export const YT_TITLE_MAX = 100;
export const YT_DESCRIPTION_MAX = 5000;
/** У YouTube предел тегов — 500 знаков вместе с разделителями; берём с запасом. */
export const YT_TAGS_TOTAL_MAX = 450;
export const YT_TAG_MAX = 30;
/** Пишем на всех площадках (спека, «Голос и музыка»). */
export const SYNTH_NOTE = 'Озвучено синтезированным голосом.';
export const STAND_MARK = '[СТЕНД] ';

/** Предел — в единицах UTF-16 (`.length`), резка — по целым символам: эмодзи на границе не распадается. */
export function clip(text: string, max: number): string {
  const str = String(text ?? '').trim();
  if (str.length <= max) return str;
  let out = '';
  for (const ch of str) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Текст сценариста + хвост (ссылка, пометка) не длиннее max: режется текст, хвост цел. */
function withTail(body: string, tail: string, max: number): string {
  return `${clip(body, max - tail.length)}${tail}`;
}

/**
 * YouTube отвергает `<` и `>` в заголовке и описании (400 — ролик не загрузится, и
 * Studio при ручной выкладке их тоже не примет). Сначала сохраняем смысл операторов и
 * стрелок (`<=`, `>=`, `->`, `<-`), потом одиночные `<`/`>` меняем на похожие ёлочки.
 * Идемпотентна (youtubeSafe(youtubeSafe(s)) === youtubeSafe(s)): после первого прохода
 * одиночных `<`/`>` не остаётся, повторный вызов — не меняет строку.
 */
export function youtubeSafe(s: string): string {
  return s
    .replace(/<=/g, '≤')
    .replace(/>=/g, '≥')
    .replace(/->/g, '→')
    .replace(/<-/g, '←')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
}

export function tidyTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of tags ?? []) {
    const tag = clip(String(raw ?? '').replace(/^#+/, '').replace(/[<>,]/g, ' ').replace(/\s+/g, ' ').trim(), YT_TAG_MAX);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    // YouTube оборачивает тег с пробелом в кавычки — они тоже входят в предел 500.
    const cost = tag.length + (tag.includes(' ') ? 2 : 0) + 1;
    if (total + cost > YT_TAGS_TOTAL_MAX) break;
    out.push(tag);
    seen.add(key);
    total += cost;
  }
  return out;
}

export interface WriterCaptionTexts {
  telegram: string;
  vk: string;
  youtube: { title: string; description: string; tags: string[] };
}

/**
 * Подписи площадок: текст сценариста, ссылка с метками этой площадки, пометка о голосе.
 * Заголовок и описание YouTube — через youtubeSafe уже здесь (не только при отправке в
 * upload() и наборе youtubeKit()): карточка проверки владельца (buildReviewCaption читает
 * эти же captions) должна показывать то же, что уйдёт на YouTube. Повторный youtubeSafe
 * при отправке — не лишний: функция идемпотентна, порчи текста не будет.
 */
export function buildCaptions(w: WriterCaptionTexts, links: Record<LinkPlatform, string>): ShortCaptions {
  return {
    telegram: withTail(w.telegram, `\n\n${links.telegram}\n\n${SYNTH_NOTE}`, TG_CAPTION_MAX),
    vk: withTail(w.vk || w.telegram, `\n\n${links.vk}\n\n${SYNTH_NOTE}`, VK_TEXT_MAX),
    youtube: {
      title: clip(youtubeSafe(w.youtube.title), YT_TITLE_MAX),
      description: withTail(youtubeSafe(w.youtube.description), `\n\n${links.youtube}\n\n${SYNTH_NOTE}`, YT_DESCRIPTION_MAX),
      tags: tidyTags(w.youtube.tags),
    },
  };
}

export interface ReviewCaptionInput {
  stand: boolean;
  rubric: ShortRubric;
  angle: ShortAngle;
  assistantName: string;
  question: string;
  when: string;
  captions: ShortCaptions;
  /** Ролик со сценками: состав (skitCastLine) и траты на оживление. */
  skits?: { cast: string; animation: ShortAnimation | null; maxOmniSeconds?: number };
}

/** Состав сценок одной строкой: герой — роль, по первому появлению («Гусыня Галина Петровна — хозяйка квартиры, Капибара Кеша — жилец»). */
export function skitCastLine(skits: Partial<Record<SkitKind, SkitPlan>>): string {
  const seen = new Map<string, string>();
  for (const kind of SKIT_KINDS) {
    for (const c of skits[kind]?.skit?.cast ?? []) {
      if (!seen.has(c.hero)) seen.set(c.hero, `${heroById(c.hero)?.name ?? c.hero} — ${c.role}`);
    }
  }
  return [...seen.values()].join(', ');
}

/** Траты на оживление: «Omni: 16 из 48 с, кадров 2 ≈ $1,86» — с пределом, если он передан. */
export function omniSpendLine(a: ShortAnimation | null, maxOmniSeconds?: number): string {
  const seconds = a?.omniSeconds ?? 0;
  const frames = a?.keyframes ?? 0;
  const usd = (seconds * OMNI_USD_PER_SEC + frames * KEYFRAME_USD).toFixed(2).replace('.', ',');
  // Предел — рядом: владелец видит, сколько пересъёмок ещё осталось у ролика.
  const of = Number.isInteger(maxOmniSeconds) ? ` из ${maxOmniSeconds}` : '';
  return `Omni: ${seconds}${of} с, кадров ${frames} ≈ $${usd}`;
}

/**
 * Подпись видео владельцу: рубрика, подача, ассистент, вопрос, время выхода и
 * подписи площадок. Не влезают в 1000 знаков — подписи идут вторым сообщением.
 */
export function buildReviewCaption(i: ReviewCaptionInput): { caption: string; extra: string | null } {
  const head = [
    `${i.stand ? STAND_MARK : ''}🎬 Ролик на проверку`,
    `Рубрика: ${RUBRIC_TITLES[i.rubric]} · подача: ${ANGLE_TITLES[i.angle].toLowerCase()}`,
    `Ассистент: ${i.assistantName}`,
    `Вопрос: «${clip(i.question, 300)}»`,
    ...(i.skits ? [`Сценки: ${clip(i.skits.cast, 200)}`, omniSpendLine(i.skits.animation, i.skits.maxOmniSeconds)] : []),
    `Выйдет: ${i.when}`,
  ].join('\n');
  const texts = [
    `Telegram:\n${i.captions.telegram}`,
    `YouTube — заголовок:\n${i.captions.youtube.title}`,
    `YouTube — описание:\n${i.captions.youtube.description}`,
  ].join('\n\n');
  const full = `${head}\n\n${texts}`;
  if (full.length <= TG_CAPTION_MAX) return { caption: full, extra: null };
  return { caption: head, extra: `Подписи к ролику\n\n${texts}` };
}
