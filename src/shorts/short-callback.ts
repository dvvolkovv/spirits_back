export type ShortCallbackAction = 'ok' | 'note' | 'redo' | 'no' | 'yt';

const ACTIONS: ShortCallbackAction[] = ['ok', 'note', 'redo', 'no', 'yt'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `short:<действие>:<id>` — ещё один префикс того же роутера кнопок, что у блога. */
export function parseShortCallback(data: string): { action: ShortCallbackAction; shortId: string } | null {
  const parts = String(data || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'short') return null;
  const action = parts[1] as ShortCallbackAction;
  if (!ACTIONS.includes(action) || !UUID.test(parts[2])) return null;
  return { action, shortId: parts[2] };
}

type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

/** Два ряда по две, как у блога: четыре кнопки в ряд на телефоне сжимаются до обрезков подписей. */
export function buildReviewKeyboard(id: string): Keyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Одобрить', callback_data: `short:ok:${id}` },
        { text: '✍️ Замечание', callback_data: `short:note:${id}` },
      ],
      [
        { text: '🔄 Переснять', callback_data: `short:redo:${id}` },
        { text: '🗑 Отклонить', callback_data: `short:no:${id}` },
      ],
    ],
  };
}

export function buildYoutubeKeyboard(id: string): Keyboard {
  return { inline_keyboard: [[{ text: '▶️ Выложил на YouTube', callback_data: `short:yt:${id}` }]] };
}

/**
 * Текст после `/short` (и `/short@Бот`) — целиком, с переносами строк, как
 * `/case` у блога. null — это не `/short`; пустая строка — команда без темы.
 */
export function shortCommandText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/^\/short(?:@[A-Za-z0-9_]+)?(?=\s|$)([\s\S]*)$/);
  return m ? m[1].trim() : null;
}

const YOUTUBE: RegExp[] = [
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{11})(?:[?#/].*)?$/i,
  /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?#/].*)?$/i,
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})(?:[&#].*)?$/i,
];

/** Пунктуация, которая в тексте владельца прилипает к ссылке без пробела. */
const TRAILING_PUNCTUATION = /[.,!?:;)\]}>»”'"]+$/;

/**
 * Ссылка на ролик в YouTube из ответа владельца — в каноническом виде
 * shorts/<id>. Домен распознаётся без учёта регистра, id — с учётом; хвостовая
 * пунктуация, прилипшая к ссылке без пробела, обрезается перед проверкой.
 */
export function parseYoutubeUrl(text: unknown): { videoId: string; url: string } | null {
  const match = String(text ?? '').match(/https?:\/\/\S+/)?.[0];
  if (!match) return null;
  const url = match.replace(TRAILING_PUNCTUATION, '');
  for (const re of YOUTUBE) {
    const m = url.match(re);
    if (m) return { videoId: m[1], url: `https://youtube.com/shorts/${m[1]}` };
  }
  return null;
}
