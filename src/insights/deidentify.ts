/**
 * Обезличивание текста перед моделью. Это эвристика, а не гарантия (спека,
 * раздел «Обезличивание»): поэтому вдобавок выход модели проверяется
 * (insights-text.ts), разметка не хранится, а сводка уходит только владельцу.
 *
 * Порядок замен важен: почта, потом ссылки (в них бывают цифры и имена), затем
 * ряды цифр, затем имена.
 */

// Хвост ссылки не кончается знаком препинания: «см. https://ozon.ru/x, а потом» —
// запятая остаётся в тексте.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()«»"]*[^\s<>()«»".,;:!?]/giu;
// Локальная часть — не длиннее 64 знаков (RFC 5321). Без потолка длинное
// слово без @ («жжж…», base64, текст без пробелов) проверялось с каждой
// позиции до конца — квадрат от длины: 12 000 знаков — около двух секунд.
const EMAIL_RE = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// Ряд цифр с разделителями внутри строки. \s сюда нельзя: склеил бы цифры
// через перевод строки («шаг 1\n2 3» превратился бы в число).
const DIGIT_RUN_RE = /\+?\d[\d \t().-]*\d/g;

/**
 * Домен оставляется только у известных площадок: «просят разобрать ссылку на
 * Озон» — полезный продуктовый сигнал. Домен же личного сайта — это сам
 * человек или его дело (ivanova.ru, сайт магазина), он уходит меткой без домена.
 */
const KNOWN_HOSTS = [
  'ozon.ru', 'wildberries.ru', 'wb.ru', 'market.yandex.ru', 'avito.ru', 't.me', 'telegram.org', 'vk.com', 'vk.ru',
  'youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'rutube.ru', 'dzen.ru', 'google.com', 'docs.google.com',
  'drive.google.com', 'yandex.ru', 'disk.yandex.ru', 'mail.ru', 'github.com', 'notion.so', 'figma.com', 'canva.com',
  'zoom.us', 'linkeon.io', 'hh.ru', 'gosuslugi.ru', 'nalog.gov.ru', 'consultant.ru',
];

function knownHost(host: string): string | null {
  return KNOWN_HOSTS.find((d) => host === d || host.endsWith(`.${d}`)) ?? null;
}

// Адрес без http и www: «мой сайт teselectro.ru». Только с узнаваемой зоной —
// иначе в ссылку превратились бы «отчёт.pdf» и «Node.js». Внутрь уже
// поставленной метки «[ссылка: t.me]» не заходит.
const BARE_HOST_RE =
  /(?<!ссылка: )(?<![\p{L}\p{N}@./-])(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+(?:ru|рф|com|net|org|io|su|pro|shop|store|online|site|biz|info|me|app|dev|ai|by|kz|uz|am|ge|de|us|uk|eu|co|tv|space|tech|art)(?![\p{L}\p{N}])(?:\/(?:[^\s<>()«»"]*[^\s<>()«»".,;:!?])?)?/giu;

function replaceLink(m: string): string {
  const host = m.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split(/[/?#:]/)[0].toLowerCase();
  const known = knownHost(host);
  return known ? `[ссылка: ${known}]` : '[ссылка]';
}

export function maskUrls(s: string): string {
  return s.replace(URL_RE, replaceLink).replace(BARE_HOST_RE, replaceLink);
}

export function maskEmails(s: string): string {
  return s.replace(EMAIL_RE, '[почта]');
}

export function maskDigits(s: string): string {
  return s.replace(DIGIT_RUN_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return '[телефон]';
    if (digits.length >= 6) return '[число]';
    return m;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Имя и его падежные формы: «Владимир», «Владимира», «Владимиру». Основа без
 * последней гласной (Анна → Анн), за ней до трёх букв, по краям — не буква.
 */
function namePattern(raw: string): string | null {
  const n = raw.trim();
  const chars = Array.from(n);
  if (chars.length < 3) return null;
  const stem = chars.length >= 4 && /[аеёиоуыэюяьйaeiouy]$/iu.test(n) ? chars.slice(0, -1).join('') : n;
  return `(?<![\\p{L}\\p{N}])${escapeRe(stem)}\\p{L}{0,3}(?![\\p{L}\\p{N}])`;
}

export function maskNames(s: string, names: readonly string[]): string {
  const patterns = new Set<string>();
  for (const raw of names) {
    for (const piece of String(raw || '').split(/[\s,]+/)) {
      const p = namePattern(piece);
      if (p) patterns.add(p);
    }
  }
  if (!patterns.size) return s;
  // Длинные основы первыми: «Владимир» не должна съесть короткая «Влад».
  const re = new RegExp([...patterns].sort((a, b) => b.length - a.length).join('|'), 'giu');
  return s.replace(re, '[имя]');
}

export function deidentify(text: string, names: readonly string[] = []): string {
  // Почта — первой: иначе «голый» домен съел бы её хвост (mail.ru), и часть
  // адреса до @ осталась бы в тексте.
  return maskNames(maskDigits(maskUrls(maskEmails(String(text || '')))), names);
}
