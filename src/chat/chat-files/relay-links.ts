// src/chat/chat-files/relay-links.ts
import type { ChatFileStore } from './chat-file-store';
import { relayFileName, relayFilesPrefix } from './file-meta';

/** Файл хода из события релея `done.outputFiles`: `url` — относительный, `/files/<ключ>/<имя>`. */
export interface RelayOutputFile {
  name: string;
  url: string;
}

/**
 * Строка ссылки, которую дописывает бэк. Только наш собственный формат.
 *
 * Строки узнаются по русской метке «Скачать». Это не текст интерфейса, а
 * фиксированный формат самого бэка (outputFileLines; так же пишут
 * chat.service.ts и chat.controller.ts). Сменить метку там — значит сменить и
 * LINK_LINE_RE: по нему же collectRelayUrls ищет строки в старой истории.
 * Имя бывает пустым: collectOutputFiles подставляет '' вместо отсутствующего.
 */
const LINK_LINE_RE = /^\[Скачать (.*)\]\((\S.*)\)$/;

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
  // Тот же origin, что в relayFilesPrefix: по нему строки потом узнаёт storeRelayLinks.
  const base = relayFilesPrefix(agentUrl).slice(0, -'/files/'.length);
  return files.map((f) => `[Скачать ${f.name}](${base}${f.url})`);
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
  const prefix = relayFilesPrefix(agentUrl);
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
 * Строка вида LINK_LINE_RE — собственная строка бэка, а не текст модели того
 * же вида: имя в ней — хвост адреса. Так пишут все источники. outputFiles и
 * форма 1 resolveEmptyFileLinks: имя — путь файла от папки хода, адрес —
 * `/files/<ключ>/<путь>`. Форма 2: имя — последний сегмент адреса,
 * раскодированный. До имени пробелов в адресе нет: ключ релея — [a-zA-Z0-9._-].
 *
 * Модель же дописывает после ссылки своё: «(PDF, 2 стр.)», «:)», заголовок
 * ссылки, вторую ссылку. Жадный LINK_LINE_RE взял бы это в адрес, а настоящий
 * адрес с того же места отбросился бы потом как обрезок — и файл потерялся бы.
 */
function isOwnLinkLine(name: string, url: string): boolean {
  if (name === '') return true;
  let head: string;
  if (url.endsWith('/' + name)) head = url.slice(0, url.length - name.length - 1);
  else if (relayFileName(url).trim() === name) head = url.slice(0, url.lastIndexOf('/'));
  else return false;
  return !/\s/.test(head);
}

/**
 * Длиннее — не строка бэка: у него строки короткие. Жадный LINK_LINE_RE на
 * длинной строке перебирает её квадратично, а строки в истории бывают и
 * враждебные: их текст пишет модель.
 */
const MAX_LINK_LINE_CHARS = 2000;
/** Концы строк — те же, что у флага m в RegExp (на них же кончается «.»). */
const LINE_BREAK_RE = /[\n\r\p{Zl}\p{Zp}]/u;

/** Цель markdown-ссылки с одним уровнем парных скобок: `](…/Договор (1).docx)`. */
const MD_TARGET_RE = /\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g;

/** Пунктуация конца фразы после голого адреса — не часть адреса. */
const TRAILING_PUNCT_CHARS = '.,;:!?»…';
/** Она же — класс для RegExp. */
const TRAILING_PUNCT = `[${TRAILING_PUNCT_CHARS}]`;

/**
 * Без заголовка ссылки — `(адрес "заголовок")` или `(адрес 'заголовок')`: он не
 * часть адреса. С конца строки, без регулярки: `\s+"…"$` на тысячах пробелов
 * подряд перебирал бы их квадратично. Режет ровно то же, что режет она:
 * пробелы и заголовок без кавычек того же вида внутри.
 */
function stripMdTitle(s: string): string {
  const q = s[s.length - 1];
  if (q !== '"' && q !== "'") return s;
  const open = s.lastIndexOf(q, s.length - 2);
  if (open < 1 || !/\s/.test(s[open - 1])) return s;
  let end = open - 1;
  while (end > 0 && /\s/.test(s[end - 1])) end--;
  return s.slice(0, end);
}

/** Без пунктуации конца фразы в хвосте — циклом с конца, а не регуляркой `[…]+$` (она квадратична на тысячах точек). */
function trimTrailingPunct(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCT_CHARS.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

/**
 * Все адреса файлов релея в тексте ответа — для разового бэкфилла истории.
 * Ошибка здесь стоит файла: обрезанный адрес даёт 404, а релей тем временем
 * чистит /tmp. Поэтому три прохода, от надёжного к общему:
 *
 *  1. Целые строки нашего формата `[Скачать имя](адрес)` (LINK_LINE_RE) — бэк
 *     всегда писал их по одной в строке. Жадно до последней «)» строки: имя
 *     бывает и с парными скобками (`Договор (1).docx`), и с непарной
 *     (`1) План.docx`), и с пробелами — релей имена не кодирует. Только если
 *     имя — хвост адреса (isOwnLinkLine); строку того же вида от модели
 *     разбирают проходы 2 и 3. Строки от MAX_LINK_LINE_CHARS — тоже им.
 *  2. Цели markdown-ссылок посреди прочего текста: один уровень парных скобок,
 *     без заголовка ссылки.
 *  3. Голые адреса, без пунктуации конца фразы в хвосте.
 *
 * Обрезок — адрес, который лишь начало другого, найденного С ТОГО ЖЕ МЕСТА
 * текста (имя с пробелом или скобкой), — отдельно не добавляется. Начало
 * адреса в другом месте текста (`…/a.pdf` рядом с `…/a.pdf.zip`) — свой файл.
 *
 * Время — линейное от длины текста: текст пишет модель, и строка в десятки
 * тысяч пробелов или точек не должна вешать перенос.
 */
export function collectRelayUrls(content: string, agentUrl: string): string[] {
  const prefix = relayFilesPrefix(agentUrl);
  const found = new Set<string>();
  const startsAt = new Map<number, string[]>();
  const add = (url: string, at: number) => {
    if (!url.startsWith(prefix) || url.length === prefix.length) return;
    const here = startsAt.get(at) || [];
    if (here.some((f) => f.length > url.length && f.startsWith(url))) return;
    found.add(url);
    startsAt.set(at, [...here, url]);
  };
  let lineAt = 0;
  for (const line of content.split(LINE_BREAK_RE)) {
    const m = line.length < MAX_LINK_LINE_CHARS ? LINK_LINE_RE.exec(line) : null;
    if (m) {
      const url = m[2].trim();
      // Адрес стоит в самом конце строки, перед закрывающей «)».
      if (isOwnLinkLine(m[1], url)) add(url, lineAt + line.length - 1 - m[2].length);
    }
    lineAt += line.length + 1;
  }
  for (const m of content.matchAll(MD_TARGET_RE)) {
    const lead = m[1].length - m[1].trimStart().length;
    const target = m[1].trim();
    // Сначала префикс: заголовок ищется только у адресов релея.
    if (target.startsWith(prefix)) add(stripMdTitle(target), m.index + 2 + lead);
  }
  const bare = new RegExp(`${escapeRe(prefix)}[^\\s\`'"<>)\\]]+`, 'g');
  for (const m of content.matchAll(bare)) {
    add(trimTrailingPunct(m[0]), m.index);
  }
  return [...found];
}

/**
 * Точная подстановка адресов. Вхождение считается, только если за ним идёт
 * конец адреса — граница или пунктуация конца фразы перед ней: иначе замена
 * `…/a.pdf` задела бы `…/a.pdf.zip`.
 */
export function replaceUrls(content: string, map: Map<string, string>): string {
  const end = `(?=${TRAILING_PUNCT}*(?:[\\s)\\]'"<>\`]|$))`;
  let out = content;
  for (const [from, to] of [...map.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`${escapeRe(from)}${end}`, 'g'), () => to);
  }
  return out;
}
