import { LanguageService } from '../common/services/language.service';
import { labelsFor } from './labels';
import { CABINET_ORIGIN, sectionUrl } from './section-links';
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
    'Раздела, которого в приложении нет, ищи в веб-кабинете my.linkeon.io, кроме оплаты и покупок. ' +
    'О балансе, покупках и оплате в этой версии приложения не говори совсем — даже о том, что не можешь о них сказать: сразу переходи к тому, что можно сделать.',
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
    nonStore: (text: string) => (client === 'store' ? '' : text),
    url: sectionUrl,
  };
}

/** Убирает разделы «## …», оставшиеся без текста: в сборке из стора так пропадают «Лимиты и цены». */
export function dropEmptySections(md: string): string {
  return md
    .split(/(?=^## )/m)
    .filter((part) => !/^## [^\n]*\n?\s*$/.test(part))
    .join('');
}

/**
 * Строка «Ссылка…: <адрес кабинета>» из раздела «Где» (url() в статьях) —
 * целиком, с переводом строки.
 *
 * Сборке из стора её не отдаём. Это Flutter-приложение: ссылку оно открывает
 * во внешнем браузере, а на страницах кабинета — баланс, покупка токенов и
 * «Скачать APK» (правило Apple 3.1.1 и решение владельца 25.10.2026; довод
 * целиком — у platformSections в chat/platform-guide.ts). Раздел «Где» при
 * этом остаётся: путь по меню в нём есть всегда.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECTION_LINK_LINE = new RegExp(`^Ссылка[^\\n]*: ${escapeRe(CABINET_ORIGIN)}/\\S*$\\n?`, 'gm');

export function renderArticle(a: KbArticle, lang: string, client: KbClient): string {
  let body = a.render(kbContext(lang, client)).trim();
  if (client === 'store') body = body.replace(SECTION_LINK_LINE, '');
  body = dropEmptySections(body);
  // В сборке для стора цен нет (paid() вырезан) — заголовок без «и цены».
  if (client === 'store') body = body.replace(/^## Лимиты и цены$/m, '## Лимиты');
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
