/**
 * Тексты сообщений в группу «Поддержка linkeon» (parse_mode HTML).
 *
 * Чистые функции: всё, что приходит снаружи, экранируется и обрезается.
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

export function toolAction(tool: string): string {
  return TOOL_ACTIONS[tool] ?? `выполнить ${tool}`;
}

export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Обрезает до max символов (кодовых точек — эмодзи не рвётся пополам) вместе с многоточием. */
export function clip(s: string, max: number): string {
  const t = String(s ?? '').trim();
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
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

export function formatToolFailure(p: {
  assistant: string;
  tool: string;
  error: string;
  userId: string;
  repeats?: Repeats | null;
}): string {
  const lines = [
    `🛠 <b>${escapeHtml(clip(p.assistant, 40))}: не получилось ${escapeHtml(toolAction(p.tool))}</b>`,
    `Ошибка: <code>${escapeHtml(clip(p.error, 300))}</code>`,
    `Пользователь: <code>${escapeHtml(p.userId)}</code>`,
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
  const who = escapeHtml(clip(p.assistant, 40));
  const head = p.kind === 'user_report'
    ? `🙋 <b>${who} передаёт жалобу пользователя</b>`
    : `🙋 <b>${who}: у меня не работает</b>`;
  return [
    head,
    `«${escapeHtml(clip(p.summary, 500))}»`,
    `Пользователь: <code>${escapeHtml(p.userId)}</code> · ${p.channel === 'telegram' ? 'Telegram' : 'веб'}`,
  ].join('\n');
}
