// src/chat/chat-files/relay-links.ts
import { ChatFileStore } from './chat-file-store';

/** Файл хода из события релея `done.outputFiles`: `url` — относительный, `/files/<ключ>/<имя>`. */
export interface RelayOutputFile {
  name: string;
  url: string;
}

/** Строка ссылки, которую дописывает бэк. Только наш собственный формат. */
const LINK_LINE_RE = /^\[Скачать (.+)\]\((\S.*)\)$/;

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Копит файлы хода из `done.outputFiles`, без повторов. Обработчик `done`
 * синхронный, копировать оттуда нельзя, поэтому файлы откладываются до конца потока.
 */
export function collectOutputFiles(into: RelayOutputFile[], list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const f of list as any[]) {
    if (!f || typeof f.url !== 'string' || !f.url) continue;
    if (into.some((p) => p.url === f.url)) continue;
    into.push({ name: String(f.name ?? ''), url: f.url });
  }
}

/** Прежний формат ссылок на файлы хода — тот же, что бэк писал до переноса в MinIO. */
export function outputFileLines(files: RelayOutputFile[], agentUrl: string): string[] {
  return files.map((f) => `[Скачать ${f.name}](${agentUrl}${f.url})`);
}

/**
 * Ссылки `[Скачать имя](адрес релея)` → на наше хранилище.
 *
 * Принимает ТОЛЬКО собственные строки бэка (outputFiles и resolveEmptyFileLinks),
 * а не текст модели. Вызывается до отправки клиенту: тот же текст уходит и в
 * поток, и в историю. Фронт сверяет ленту с историей посимвольно
 * (historyMerge.ts), и разные адреса в двух местах задвоили бы ответ.
 *
 * Никогда не бросает: без хранилища или при его сбое строки возвращаются как были.
 */
export async function storeRelayLinks(
  lines: string[],
  agentUrl: string,
  store: Pick<ChatFileStore, 'persist'> | undefined,
  warn: (msg: string) => void = () => {},
): Promise<string[]> {
  const prefix = `${agentUrl.replace(/\/$/, '')}/files/`;
  const parsed = lines.map((line) => {
    const m = line.match(LINK_LINE_RE);
    return m && m[2].startsWith(prefix) ? { name: m[1], url: m[2] } : null;
  });
  const urls = parsed.filter((p): p is { name: string; url: string } => p !== null).map((p) => p.url);
  if (urls.length === 0) return lines;
  if (!store) {
    warn('chat-files: хранилище не подключено — ссылки остаются на релее');
    return lines;
  }
  let stored: Map<string, string>;
  try {
    stored = await store.persist(urls);
  } catch (e: any) {
    warn(`chat-files: копия не удалась — ссылки остаются на релее: ${e?.message || e}`);
    return lines;
  }
  return lines.map((line, i) => {
    const p = parsed[i];
    const to = p ? stored.get(p.url) : undefined;
    return p && to ? `[Скачать ${p.name}](${to})` : line;
  });
}

/**
 * Все адреса файлов релея в тексте ответа: цели markdown-ссылок (там бывают
 * пробелы — релей имена не кодирует) и голые адреса.
 */
export function collectRelayUrls(content: string, agentUrl: string): string[] {
  const prefix = escapeRe(`${agentUrl.replace(/\/$/, '')}/files/`);
  const found = new Set<string>();
  for (const m of content.matchAll(new RegExp(`\\]\\((${prefix}[^)\\n]+)\\)`, 'g'))) {
    found.add(m[1].trim());
  }
  for (const m of content.matchAll(new RegExp(`${prefix}[^\\s\`'"<>)\\]]+`, 'g'))) {
    const url = m[0];
    // Начало цели ссылки с пробелом в имени — она уже учтена целиком.
    if (![...found].some((f) => f !== url && f.startsWith(url))) found.add(url);
  }
  return [...found];
}

/**
 * Точная подстановка адресов. Вхождение считается, только если за ним идёт
 * конец адреса: иначе замена `…/a.pdf` задела бы `…/a.pdf.zip`.
 */
export function replaceUrls(content: string, map: Map<string, string>): string {
  let out = content;
  for (const [from, to] of [...map.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`${escapeRe(from)}(?=[\\s)\\]'"<>\`]|$)`, 'g'), () => to);
  }
  return out;
}
