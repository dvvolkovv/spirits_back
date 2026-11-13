import { ChatFileKind, kindByExt, stripCode } from './extract';
import { fileExt } from './file-meta';

/**
 * Поиск файлов для инструмента find_files: разбор того, что прислала модель,
 * и ранжирование. Чистые функции — всё под тестами (find-files.spec.ts).
 */

export interface FindFilesInput {
  /** Пустая строка — без слов: просто последние файлы. */
  query: string;
  /** 'link' — внешние ссылки из человеческих сообщений: не файл, а адрес. */
  kind: ChatFileKind | 'link' | 'any';
  /** Пустая строка — у любого ассистента. */
  assistant: string;
  days: number | null;
  limit: number;
}

export const FIND_FILES_DEFAULT_LIMIT = 10;
export const FIND_FILES_MAX_LIMIT = 30;
const KINDS = new Set(['image', 'video', 'document', 'audio', 'link', 'any']);

/** Вход от модели: типы приводятся, лишнее отбрасывается, числа зажимаются в рамки. */
export function parseFindFilesInput(raw: any): FindFilesInput {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const num = (v: unknown) => Math.floor(typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);
  const kind = str(raw?.kind, 20).toLowerCase();
  const days = num(raw?.days);
  const limit = num(raw?.limit);
  return {
    query: str(raw?.query, 200),
    kind: (KINDS.has(kind) ? kind : 'any') as FindFilesInput['kind'],
    assistant: str(raw?.assistant, 60),
    days: Number.isFinite(days) && days >= 1 ? Math.min(days, 3650) : null,
    limit: Number.isFinite(limit) && limit >= 1 ? Math.min(limit, FIND_FILES_MAX_LIMIT) : FIND_FILES_DEFAULT_LIMIT,
  };
}

/** Для сравнения: регистр, «ё» и составные символы не мешают найти. */
export function normalizeForSearch(s: string): string {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
}

/** Слова запроса — куски из букв и цифр от двух знаков, без повторов. */
export function queryWords(query: string): string[] {
  return [...new Set(normalizeForSearch(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))];
}

/** Очки файла: 3 за слово в имени, 1 — за слово в тексте ответа, где файл появился. */
export function scoreFile(words: string[], name: string, text: string): number {
  const n = normalizeForSearch(name);
  const t = normalizeForSearch(text);
  let score = 0;
  for (const w of words) {
    if (n.includes(w)) score += 3;
    if (t.includes(w)) score += 1;
  }
  return score;
}

/** Текст ответа без разметки, адресов и маркеров — короткая подпись к найденному файлу. */
export function plainNote(text: string, max = 200): string {
  const s = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[(?:VIDEO_JOB|CALENDAR_PROPOSAL):[^\]]*\]|\{\{[^}]*\}\}/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_>`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

/** Ассистент переписки из session_id: число или `custom:<uuid>`; хвост «Чистого листа» срезается. */
export function assistantPart(sessionId: string, userId: string): string {
  if (!sessionId.startsWith(`${userId}_`)) return '';
  return sessionId.slice(userId.length + 1).replace(/_fresh_\d+$/, '');
}

/** Вид исходной загрузки: сначала по mime, без явного семейства — по расширению имени. */
export function kindByMime(mime: string, name: string): ChatFileKind {
  const m = String(mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return kindByExt(fileExt(String(name ?? '')));
}

/** Внешняя ссылка из человеческого сообщения: адрес и подпись markdown-ссылки, если была. */
export interface HumanLink {
  url: string;
  text: string;
}

// Цель ссылки допускает один уровень парных скобок — как MD_LINK_RE в extract.ts:
// «.../Файл_(формат)» не должно обрезаться на первой «)».
const MD_HTTP_RE = /\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g;
const BARE_HTTP_RE = /https?:\/\/[^\s<>"]+/gi;

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Хвостовая пунктуация и незакрытые обёртки в адрес не входят: «(https://x)»
 * или «https://x.» — это оформление сообщения. Парные скобки внутри адреса
 * сохраняются: «.../Файл_(формат)» — часть URL.
 */
export function trimUrlTail(url: string): string {
  let u = String(url ?? '').trim();
  for (;;) {
    const before = u;
    u = u.replace(/[.,;:!?…'"»]+$/, '');
    while (u.endsWith(')') && countChar(u, ')') > countChar(u, '(')) u = u.slice(0, -1);
    while (u.endsWith(']') && countChar(u, ']') > countChar(u, '[')) u = u.slice(0, -1);
    if (u === before) return u;
  }
}

/**
 * Внешние ссылки из сообщения человека (источник origin=link инструмента
 * find_files). Содержимое по ним НЕ скачивается — это только адрес. Внутренние
 * /webhook/chat-uploads/ исключены: исходники покрывает отдельный источник,
 * дубль показал бы пользователю служебный подписанный путь. Повтор адреса —
 * одна запись (первая, с подписью markdown, если она была).
 */
export function extractHumanLinks(content: string): HumanLink[] {
  const text = stripCode(String(content ?? ''));
  const out: HumanLink[] = [];
  const seen = new Set<string>();
  const push = (rawUrl: string, label: string): void => {
    // Хвост вида `url "title"` — заголовок markdown-ссылки, не часть адреса.
    const url = trimUrlTail(rawUrl.replace(/\s+"[^"]*"?\s*$/, ''));
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    if (url.includes('/webhook/chat-uploads/')) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, text: label.trim() });
  };
  for (const m of text.matchAll(MD_HTTP_RE)) {
    const target = m[2].trim();
    if (/^https?:\/\//i.test(target)) push(target, m[1]);
  }
  for (const m of text.matchAll(BARE_HTTP_RE)) push(m[0], '');
  return out;
}
