import { SLUG_PATTERN } from './short-slug';

export type LinkPlatform = 'telegram' | 'vk' | 'youtube';

export const DEFAULT_LINK_BASE = 'https://my.linkeon.io';

/** Адрес кабинета в ссылках роликов. На стенде — test.linkeon.io, чтобы клики проверки не шли в прод. */
export function linkBase(env: Record<string, string | undefined> = process.env): string {
  return (env.SHORTS_LINK_BASE?.trim() || DEFAULT_LINK_BASE).replace(/\/+$/, '');
}

/** Куда ведёт ссылка: в чат ассистента, которого зритель видел (кабинет помнит его до входа). */
export function shortTarget(assistantId: number | null): string {
  return assistantId ? `chat?assistant=${assistantId}` : 'chat';
}

/** Ссылка с метками площадки: utm_medium=short, utm_campaign=sh_<slug> (спека, «Метки и измерение»). */
export function shortLink(o: { base: string; target: string; platform: LinkPlatform; slug: string }): string {
  if (!SLUG_PATTERN.test(o.slug)) {
    throw new Error(`shorts: слаг «${o.slug}» не годится для метки — только [a-z0-9_], до 40 знаков`);
  }
  const url = new URL(`${o.base}/${o.target}`);
  url.searchParams.set('utm_source', o.platform);
  url.searchParams.set('utm_medium', 'short');
  url.searchParams.set('utm_campaign', `sh_${o.slug}`);
  return url.toString();
}

export function shortLinks(base: string, target: string, slug: string): Record<LinkPlatform, string> {
  return {
    telegram: shortLink({ base, target, platform: 'telegram', slug }),
    vk: shortLink({ base, target, platform: 'vk', slug }),
    youtube: shortLink({ base, target, platform: 'youtube', slug }),
  };
}
