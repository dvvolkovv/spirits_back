import { tgText } from './tg-i18n';
import { DEFAULT_LANGUAGE } from '../common/services/language.service';
/**
 * Инлайн-клавиатура выбора ассистента.
 *
 * По одному в строке: имена длинные («Екатерина», «Александра»), два в ряд
 * обрезаются на узких экранах. 19 ассистентов не влезают в одно сообщение —
 * отсюда пагинация.
 *
 * callback_data несёт ИМЯ, а не id: preferred_agent хранит имя, и
 * AgentsService.changeAgent принимает тоже имя. Лимит Telegram на
 * callback_data — 64 байта; имена ассистентов заведомо короче.
 */
export const PAGE_SIZE = 8;

export interface KeyboardAgent {
  id: number | string;
  name: string;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export function buildAssistantsKeyboard(
  agents: KeyboardAgent[],
  page: number,
  current: string | null,
  lang: string = DEFAULT_LANGUAGE,
): { inline_keyboard: InlineButton[][] } {
  const start = page * PAGE_SIZE;
  const slice = agents.slice(start, start + PAGE_SIZE);

  const rows: InlineButton[][] = slice.map((a) => [
    {
      text: a.name === current ? `✓ ${a.name}` : a.name,
      callback_data: `agent:${a.name}`,
    },
  ]);

  const nav: InlineButton[] = [];
  if (page > 0) nav.push({ text: tgText(lang, 'nav_back'), callback_data: `agents_page:${page - 1}` });
  if (start + PAGE_SIZE < agents.length) {
    nav.push({ text: tgText(lang, 'nav_next'), callback_data: `agents_page:${page + 1}` });
  }
  if (nav.length) rows.push(nav);

  return { inline_keyboard: rows };
}
