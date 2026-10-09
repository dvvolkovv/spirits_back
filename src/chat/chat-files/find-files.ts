import { ChatFileKind } from './extract';

/**
 * Поиск файлов для инструмента find_files: разбор того, что прислала модель,
 * и ранжирование. Чистые функции — всё под тестами (find-files.spec.ts).
 */

export interface FindFilesInput {
  /** Пустая строка — без слов: просто последние файлы. */
  query: string;
  kind: ChatFileKind | 'any';
  /** Пустая строка — у любого ассистента. */
  assistant: string;
  days: number | null;
  limit: number;
}

export const FIND_FILES_DEFAULT_LIMIT = 10;
export const FIND_FILES_MAX_LIMIT = 30;
const KINDS = new Set(['image', 'video', 'document', 'audio', 'any']);

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
