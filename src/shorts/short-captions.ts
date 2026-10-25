import { LinkPlatform } from './short-links';
import { ANGLE_TITLES, RUBRIC_TITLES, ShortAngle, ShortCaptions, ShortRubric } from './shorts.types';

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

/** По символам, а не по UTF-16: эмодзи на границе не распадается пополам. */
export function clip(text: string, max: number): string {
  const chars = Array.from(String(text ?? '').trim());
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** Текст сценариста + хвост (ссылка, пометка) не длиннее max: режется текст, хвост цел. */
function withTail(body: string, tail: string, max: number): string {
  return `${clip(body, max - Array.from(tail).length)}${tail}`;
}

export function tidyTags(tags: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const raw of tags ?? []) {
    const tag = clip(String(raw ?? '').replace(/^#+/, '').replace(/[<>,]/g, ' ').replace(/\s+/g, ' ').trim(), YT_TAG_MAX);
    if (!tag || out.includes(tag)) continue;
    const cost = Array.from(tag).length + 1;
    if (total + cost > YT_TAGS_TOTAL_MAX) break;
    out.push(tag);
    total += cost;
  }
  return out;
}

export interface WriterCaptionTexts {
  telegram: string;
  vk: string;
  youtube: { title: string; description: string; tags: string[] };
}

/** Подписи площадок: текст сценариста, ссылка с метками этой площадки, пометка о голосе. */
export function buildCaptions(w: WriterCaptionTexts, links: Record<LinkPlatform, string>): ShortCaptions {
  return {
    telegram: withTail(w.telegram, `\n\n${links.telegram}\n\n${SYNTH_NOTE}`, TG_CAPTION_MAX),
    vk: withTail(w.vk || w.telegram, `\n\n${links.vk}\n\n${SYNTH_NOTE}`, VK_TEXT_MAX),
    youtube: {
      title: clip(w.youtube.title, YT_TITLE_MAX),
      description: withTail(w.youtube.description, `\n\n${links.youtube}\n\n${SYNTH_NOTE}`, YT_DESCRIPTION_MAX),
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
    `Выйдет: ${i.when}`,
  ].join('\n');
  const texts = [
    `Telegram:\n${i.captions.telegram}`,
    `YouTube — заголовок:\n${i.captions.youtube.title}`,
    `YouTube — описание:\n${i.captions.youtube.description}`,
  ].join('\n\n');
  const full = `${head}\n\n${texts}`;
  if (Array.from(full).length <= TG_CAPTION_MAX) return { caption: full, extra: null };
  return { caption: head, extra: `Подписи к ролику\n\n${texts}` };
}
