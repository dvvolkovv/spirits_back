/**
 * Тексты сообщений в группу «Поддержка linkeon» (parse_mode HTML).
 *
 * Чистые функции: всё, что приходит снаружи, сводится в одну строку (кроме
 * текста ошибки — он многострочный внутри `<code>`), обрезается и
 * экранируется, поэтому сообщение всегда разбирается и короче лимита Telegram
 * (4096). Это важно: об отказе Telegram отправка не узнаёт
 * (common/telegram-alert.ts только пишет в лог), и сбой ушёл бы в тишину.
 * Аргументов инструмента (промпт видео, текст озвучки) здесь нет и быть не
 * должно — решение владельца 24.10.2026: в группу уходит только служебное.
 */

/** Что не получилось — по инструменту из CHAT_TOOLS (src/chat/chat-tools.ts). */
const TOOL_ACTIONS: Record<string, string> = {
  generate_image: 'создать картинку',
  generate_banner: 'сделать баннер',
  edit_image: 'изменить картинку',
  compose_image: 'совместить картинки',
  upscale_image: 'улучшить картинку',
  generate_video: 'создать видео',
  generate_speech: 'озвучить текст',
  manage_routine: 'настроить рутину',
  propose_calendar_event: 'предложить событие в календарь',
  read_calendar: 'прочитать календарь',
  calculate_human_design: 'рассчитать бодиграф',
};

export const FALLBACK_NAME = 'Ассистент';
/** Потолки полей: всё сообщение — около 1,3 тыс. видимых символов при лимите Telegram 4096. */
const MAX_NAME = 40;
const MAX_ID = 64;
const MAX_ERROR = 300;
const MAX_SUMMARY = 500;

export function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Одна строка: переводы строк и повторы пробелов чужого текста — в один пробел. */
export function oneLine(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Начало чужого текста: дальше 16·max единиц UTF-16 не смотрим, срез — по
 * границе кодовой точки, отрезанное помечаем «…». Нужен ДО oneLine: та
 * проходит всю строку, а пересказ модели по длине ничем больше не ограничен.
 */
export function head(s: string, max: number): string {
  const t = String(s ?? '');
  const bound = 16 * max;
  if (t.length <= bound) return t;
  const end = /[\uD800-\uDBFF]/.test(t[bound - 1]) ? bound - 1 : bound;
  return `${t.slice(0, end)}…`;
}

/**
 * Обрезает до max символов вместе с многоточием. Режет по кодовым точкам —
 * суррогатную пару (эмодзи) не рвёт; составные эмодзи (ZWJ, флаги) может
 * разделить, Telegram такое принимает. В массив разворачивает только начало
 * строки: пересказ модели на пути Б по длине ничем больше не ограничен.
 */
export function clip(s: string, max: number): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  // max+1 кодовых точек всегда умещаются в 2·max+2 единицах UTF-16.
  const chars = Array.from(t.slice(0, 2 * max + 2));
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : t;
}

export function toolAction(tool: string): string {
  // Своё свойство, а не через прототип: «toString» и «constructor» не должны
  // превращаться в текст функции.
  return Object.prototype.hasOwnProperty.call(TOOL_ACTIONS, tool)
    ? TOOL_ACTIONS[tool]
    : `выполнить ${clip(oneLine(head(tool, MAX_ID)), MAX_ID)}`;
}

const RU = new Intl.PluralRules('ru');

/** «1 раз», «2 раза», «5 раз». */
export function timesRu(n: number): string {
  return `${n} ${RU.select(n) === 'few' ? 'раза' : 'раз'}`;
}

/** «у 1 пользователя», «у 2 пользователей», «у 21 пользователя». */
export function usersRu(n: number): string {
  return `у ${n} ${RU.select(n) === 'one' ? 'пользователя' : 'пользователей'}`;
}

export interface Repeats {
  count: number;
  users: number;
}

/** Имя ассистента для заголовка: одна строка, не длиннее 40, пустое — «Ассистент». */
function nameOf(assistant: string): string {
  return escapeHtml(clip(oneLine(head(assistant, MAX_NAME)), MAX_NAME) || FALLBACK_NAME);
}

function userLine(userId: string): string {
  return `Пользователь: <code>${escapeHtml(clip(oneLine(head(userId, MAX_ID)), MAX_ID))}</code>`;
}

export function formatToolFailure(p: {
  assistant: string;
  tool: string;
  error: string;
  userId: string;
  repeats?: Repeats | null;
}): string {
  const lines = [
    `🛠 <b>${nameOf(p.assistant)}: не получилось ${escapeHtml(toolAction(p.tool))}</b>`,
    `Ошибка: <code>${escapeHtml(clip(p.error, MAX_ERROR))}</code>`,
    userLine(p.userId),
  ];
  if (p.repeats && p.repeats.count > 0) {
    lines.push(`С прошлого сообщения: ещё ${timesRu(p.repeats.count)} ${usersRu(p.repeats.users)}`);
  }
  return lines.join('\n');
}

export type ProblemKind = 'my_failure' | 'user_report';
export type ProblemChannel = 'web' | 'telegram';

export function formatAssistantReport(p: {
  assistant: string;
  kind: ProblemKind;
  summary: string;
  userId: string;
  channel: ProblemChannel;
}): string {
  const who = nameOf(p.assistant);
  const headLine = p.kind === 'user_report'
    ? `🙋 <b>${who} передаёт жалобу пользователя</b>`
    : `🙋 <b>${who}: у меня не работает</b>`;
  return [
    headLine,
    `«${escapeHtml(clip(oneLine(head(p.summary, MAX_SUMMARY)), MAX_SUMMARY))}»`,
    `${userLine(p.userId)} · ${p.channel === 'telegram' ? 'Telegram' : 'веб'}`,
  ].join('\n');
}
