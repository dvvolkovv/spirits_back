import { LanguageService } from '../common/services/language.service';
import { labelsFor } from './labels';
import type { KbLabelKey } from './labels.generated';
import type { KbArticle, KbClient, KbContext, KbLang } from './kb.types';

/**
 * Пометка для модели в начале статьи: где сейчас пользователь. Статьи описывают
 * веб-кабинет; у Flutter-приложения меню своё, а в Telegram нет ни кабинета, ни
 * части инструментов.
 */
export const CLIENT_NOTES: Record<KbClient, string> = {
  web: '',
  app:
    'Пользователь в мобильном приложении Linkeon: меню там своё, и пункты могут называться иначе. ' +
    'Раздела, которого в приложении нет, ищи в веб-кабинете my.linkeon.io.',
  store:
    'Пользователь в мобильном приложении Linkeon: меню там своё, и пункты могут называться иначе. ' +
    'Раздела, которого в приложении нет, ищи в веб-кабинете my.linkeon.io. ' +
    'О балансе, покупках и оплате в этой версии приложения не говори совсем.',
  telegram:
    'Разговор идёт в Telegram. Всё, что ниже, делается в веб-кабинете Linkeon — my.linkeon.io; ' +
    'в Telegram у ассистента меньше инструментов.',
};

export function kbContext(lang: string, client: KbClient): KbContext {
  const l = labelsFor(lang);
  return {
    lang: LanguageService.normalize(lang) as KbLang,
    client,
    q: (key: KbLabelKey) => `«${l[key]}»`,
    paid: (text: string) => (client === 'store' ? '' : text),
  };
}

/** Убирает разделы «## …», оставшиеся без текста: в сборке из стора так пропадают «Лимиты и цены». */
export function dropEmptySections(md: string): string {
  return md
    .split(/(?=^## )/m)
    .filter((part) => !/^## [^\n]*\n?\s*$/.test(part))
    .join('');
}

export function renderArticle(a: KbArticle, lang: string, client: KbClient): string {
  const body = dropEmptySections(a.render(kbContext(lang, client)).trim());
  return [`# ${a.title}`, CLIENT_NOTES[client], body]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Темы, доступные клиенту: в сборке из стора — без тем о деньгах. */
export function topicsFor(client: KbClient, registry: readonly KbArticle[]): KbArticle[] {
  return registry.filter((a) => !(client === 'store' && a.paidOnly));
}

/** Перечень тем строкой на тему — для описания инструмента и ответа без статей. */
export function renderIndex(client: KbClient, registry: readonly KbArticle[]): string {
  return topicsFor(client, registry)
    .map((a) => `- ${a.id} — ${a.summary}`)
    .join('\n');
}
