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

/**
 * Потолок длины адреса. Настоящие URL длиннее пары килобайт — редкость, а
 * «ссылка» из мегабайта скобок — мусор или атака: без cap разбор хвоста
 * держал бы event loop. Всё, что длиннее, ссылкой не считается.
 */
export const MAX_LINK_URL_CHARS = 2048;

const TAIL_PUNCT = '.,;:!?…\'"»';

/**
 * Хвостовая пунктуация и незакрытые обёртки в адрес не входят: «(https://x)»
 * или «https://x.» — это оформление сообщения. Парные скобки внутри адреса
 * сохраняются: «.../Файл_(формат)» — часть URL.
 *
 * Линейно: баланс скобок считается одним проходом, снятие хвоста идёт с конца
 * с декрементом баланса. Пересчёт баланса на каждой итерации (прежняя версия)
 * давал O(M²) — на сообщении из 100 тысяч «)» это были минуты блокировки
 * общего прод-процесса на каждый find_files этого пользователя.
 */
export function trimUrlTail(url: string): string {
  const u = String(url ?? '').trim();
  let round = 0;
  let square = 0;
  for (const ch of u) {
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
  }
  let end = u.length;
  while (end > 0) {
    const ch = u[end - 1];
    if (TAIL_PUNCT.includes(ch)) { end--; continue; }
    if (ch === ')' && round < 0) { end--; round++; continue; }
    if (ch === ']' && square < 0) { end--; square++; continue; }
    break;
  }
  return u.slice(0, end);
}

/**
 * Внешние ссылки из сообщения человека (источник origin=link инструмента
 * find_files). Содержимое по ним НЕ скачивается — это только адрес. Внутренние
 * /webhook/chat-uploads/ исключены: исходники покрывает отдельный источник,
 * дубль показал бы пользователю служебный подписанный путь.
 *
 * Дедуп по адресу: внутри сообщения выигрывает первое вхождение (markdown-проход
 * идёт раньше bare — если адрес был ссылкой с подписью, подпись сохранится);
 * между сообщениями — самое свежее (строки истории идут от новых к старым,
 * см. seenLinks в searchForUser).
 */
export function extractHumanLinks(content: string): HumanLink[] {
  const text = stripCode(String(content ?? ''));
  const out: HumanLink[] = [];
  const seen = new Set<string>();
  const push = (rawUrl: string, label: string): void => {
    if (rawUrl.length > MAX_LINK_URL_CHARS) return;
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
