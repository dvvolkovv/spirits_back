// src/chat/chat-files/file-meta.ts
/**
 * Имя, тип и заголовки файла переписки (chat-files).
 *
 * Чистые функции, и все под тестами (file-meta.spec.ts). От них зависит, как
 * файл назовётся у пользователя при скачивании и откроется ли он страницей на
 * нашем домене. Последнее — вопрос безопасности, а не вкуса: у my.linkeon.io в
 * localStorage лежат токены входа, а ассистенты делают и .html, и .svg.
 */

/** Сколько символов имени оставляем; расширение при обрезке сохраняется. */
export const MAX_NAME_CHARS = 150;

/** Расширение в нижнем регистре без точки; пустая строка — если его нет. */
export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** decodeURIComponent, который не бросает на одиноком «%». */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Последний сегмент пути адреса — без query и якоря, раскодированный. */
export function lastPathSegment(url: string): string {
  const path = url.split(/[?#]/)[0];
  const seg = path.split('/').filter(Boolean).pop() || '';
  return safeDecode(seg);
}

/**
 * Имя для ключа в бакете и для Content-Disposition: без разделителей пути и
 * управляющих символов, не длиннее MAX_NAME_CHARS. Пустое — `file`.
 */
export function safeFileName(raw: string): string {
  const cleaned = Array.from(String(raw ?? '').normalize('NFC'))
    .map((ch) => (ch === '/' || ch === '\\' ? '_' : ch))
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 32 && !(c >= 127 && c < 160);
    })
    .join('')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  const chars = Array.from(cleaned);
  if (chars.length <= MAX_NAME_CHARS) return cleaned;
  const tail = fileExt(cleaned) ? cleaned.slice(cleaned.lastIndexOf('.')) : '';
  return chars.slice(0, MAX_NAME_CHARS - Array.from(tail).length).join('') + tail;
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  stl: 'model/stl',
};

/**
 * Типы, которые браузер исполнил бы как страницу или скрипт. Content-Disposition:
 * attachment и так не даёт открыть файл переходом; октет-поток — вторая линия на
 * случай, если заголовок где-то по дороге потеряется. SVG сюда не входит: превью
 * в панели рисуется через <img>, а там его скрипты не выполняются.
 */
const ACTIVE = new Set(['html', 'htm', 'xhtml', 'xml', 'js', 'mjs']);

export function contentTypeFor(name: string): string {
  const ext = fileExt(name);
  if (ACTIVE.has(ext)) return 'application/octet-stream';
  return TYPES[ext] || 'application/octet-stream';
}

/**
 * encodeURIComponent плюс символы, которые он оставляет как есть: ' ( ) * !
 * Для имени в нашем адресе: сырая скобка рвёт markdown-ссылку
 * `[Скачать 1) План.docx](…/1) План.docx)` на первой же «)». Годится и для
 * filename* (RFC 5987): закодированный символ там допустим всегда.
 */
export function encodeStrict(s: string): string {
  return encodeURIComponent(s).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * `attachment` у всех файлов переписки: по прямому переходу файл скачивается, а
 * не открывается на нашем домене. ASCII-замена — для клиентов, которые не
 * читают filename*.
 */
export function contentDispositionFor(name: string): string {
  const ascii = Array.from(name)
    .map((ch) => (ch >= ' ' && ch <= '~' && ch !== '"' && ch !== '\\' ? ch : '_'))
    .join('');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeStrict(name)}`;
}

/**
 * Адрес для запроса к релею. Релей отдаёт ссылки сырыми (`/files/<ключ>/<путь>`,
 * путь без кодирования, бывает с подпапками), а в тексте ответа они бывают и
 * уже закодированными. Поэтому каждый сегмент пути после origin раскодируется
 * и кодируется заново: `%20` не станет `%2520`, `%2C` — `%252C`, а «?» и «#»
 * из имени уйдут как %3F и %23, а не обрежут путь. URL-парсер к сырой строке
 * не применяем: он счёл бы «?…» запросом, а «#…» якорем.
 */
export function relayRequestUrl(url: string): string {
  const m = /^([a-z][a-z\d+.-]*:\/\/[^/]*)([\s\S]*)$/i.exec(url);
  if (!m) return url;
  return m[1] + m[2].split('/').map((seg) => encodeURIComponent(safeDecode(seg))).join('/');
}

/**
 * Имя файла из адреса релея: последний сегмент пути целиком, раскодированный.
 * Путь у релея сырой, поэтому «?» и «#» здесь — часть имени (`Задача #3.docx`),
 * а не начало запроса или якоря. Для обычных адресов — lastPathSegment.
 */
export function relayFileName(url: string): string {
  return safeDecode(url.slice(url.lastIndexOf('/') + 1));
}
