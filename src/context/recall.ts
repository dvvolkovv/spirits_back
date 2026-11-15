/**
 * Поиск по тому, что уже записано: заметкам человека и резюме его прошлых разговоров.
 *
 * ⚠️ **Зачем.** Память ассистента была односторонней: `save_note` и
 * `create_document` писали, а прочитать записанное было нечем. Живой звонок
 * 13.11.2026 — человек просит «прочитай заметку, которую мы в прошлый раз
 * сделали», Роман отвечает «у меня нет прямого доступа читать твои заметки»,
 * и человек вынужден пересказывать вслух то, что уже сформулировано письменно.
 * Заметка при этом существовала. Спека:
 * `docs/superpowers/specs/2026-11-14-roman-recall-design.md`.
 *
 * Здесь только чистая логика: нормализация, счёт, потолки. Выборки — в
 * {@link RecallService}.
 */

export type RecallKind = 'note' | 'talk';

/** Кандидат на выдачу: заметка или прошлый разговор, приведённые к одному виду. */
export interface RecallCandidate {
  kind: RecallKind;
  title: string;
  text: string;
  /** Когда это появилось, мс. 0 — источник даты не дал. */
  at: number;
}

/** Что уезжает в модель. */
export interface RecallItem {
  kind: RecallKind;
  title: string;
  /** дд.мм.гггг; пусто, если источник даты не дал. */
  date: string;
  text: string;
}

/**
 * Потолки выдачи. Найденный текст становится частью контекста Realtime и
 * дальше переигрывается в КАЖДОМ ходе разговора — то есть платится не один
 * раз. Та же причина, по которой в лаунчере стоит `PromptLimit`: длинный
 * кусок, доехавший до модели, стоит денег и размывает ответ.
 */
export const RECALL_MAX_ITEMS = 3;
export const RECALL_ITEM_CHARS = 1200;
export const RECALL_TOTAL_CHARS = 3000;

/**
 * Слова, которыми в живой речи ССЫЛАЮТСЯ на прошлое, а не описывают его.
 *
 * «Посмотри, что мы делали в прошлый раз» — здесь нет ни одного слова о теме,
 * и искать по ним бессмысленно: совпадёт либо всё, либо ничего. Такой запрос
 * считается неопределённым, и ответом на него служит самое свежее.
 *
 * Хранятся УЖЕ в виде корней (см. {@link stems}), иначе список не совпадёт
 * сам с собой.
 */
const STOP = new Set([
  'прошл', 'после', 'недав', 'ранее', 'тогда', 'котор', 'посмо', 'раз',
  'замет', 'разго', 'говор', 'делал', 'дела', 'вспом', 'помни', 'помн',
  'найди', 'поищи', 'напом', 'что', 'про', 'как', 'там', 'тот', 'та', 'то',
  'это', 'был', 'было', 'были', 'наш', 'наши', 'себе', 'еще', 'тема', 'теме',
  'тему', 'обсуж', 'конте', 'ссылк',
]);

/**
 * Грубые корни слов запроса или текста.
 *
 * Русская морфология тут не нужна: корпус маленький (десятки заметок, сотни
 * разговоров у человека), и обрезка слова до пяти букв склеивает «финансового»
 * с «финансами» достаточно надёжно. Слова короче четырёх букв не режутся —
 * иначе «дом» и «долг» стали бы одним словом.
 */
export function stems(s: string): string[] {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length > 2)
    .map((w) => (w.length > 3 ? w.slice(0, 5) : w));
}

/** Корни, по которым есть смысл искать. */
function meaningful(s: string): string[] {
  return stems(s).filter((w) => !STOP.has(w));
}

/** Запрос, в котором нет ни одного слова о теме, — «то, что в прошлый раз». */
export function isVague(query: string): boolean {
  return meaningful(query).length === 0;
}

/** Совпадение в заголовке весит больше: заголовок человек задавал сам и про тему. */
function score(c: RecallCandidate, q: string[]): number {
  const inTitle = new Set(stems(c.title));
  const inText = new Set(stems(c.text));
  let total = 0;
  for (const w of q) {
    if (inTitle.has(w)) total += 3;
    else if (inText.has(w)) total += 1;
  }
  return total;
}

/**
 * Отбор. Неопределённый запрос → свежее; определённый без совпадений → ПУСТО.
 *
 * ⚠️ Пустая выдача здесь — поведение, а не пробел. Если на вопрос про ипотеку
 * вернуть «самое свежее», модель уверенно перескажет вчерашний разговор про
 * другое. Честное «не нашёл, напомни двумя тезисами» дешевле выдумки.
 */
export function rankRecall(cands: RecallCandidate[], query: string): RecallCandidate[] {
  const byFresh = (a: RecallCandidate, b: RecallCandidate) => b.at - a.at;
  const q = meaningful(query);
  if (!q.length) return [...cands].sort(byFresh);
  return cands
    .map((c) => ({ c, s: score(c, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || byFresh(a.c, b.c))
    .map((x) => x.c);
}

function dateOf(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Обрез с многоточием ВНУТРИ потолка: заслон, нарушающий свой же предел, ничего не держит. */
function cut(text: string, cap: number): string {
  const t = String(text || '').trim();
  return t.length <= cap ? t : t.slice(0, cap - 1) + '…';
}

/** Потолки по числу элементов, по каждому и по сумме. */
export function capRecall(cands: RecallCandidate[]): RecallItem[] {
  const out: RecallItem[] = [];
  let left = RECALL_TOTAL_CHARS;
  for (const c of cands.slice(0, RECALL_MAX_ITEMS)) {
    // Огрызок в полсотни знаков не несёт смысла и только занимает место.
    if (left < 100) break;
    const text = cut(c.text, Math.min(RECALL_ITEM_CHARS, left));
    left -= text.length;
    out.push({ kind: c.kind, title: c.title, date: dateOf(c.at), text });
  }
  return out;
}
