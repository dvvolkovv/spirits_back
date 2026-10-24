import { Logger } from '@nestjs/common';
import { KB_ARTICLES } from './articles';
import type { KbArticle, KbClient } from './kb.types';
import { renderArticle, renderIndex, topicsFor } from './render';

/**
 * Инструмент справки о платформе. Живёт на точке /webhook/mcp/products
 * (products-mcp.controller.ts) — её получают все ассистенты релея, Маша и боты
 * в Telegram; ИИ-поддержка зовёт его внутри процесса (support.service.ts).
 * Полное имя у CLI — mcp__products__linkeon_help (products-cli-tool.ts).
 *
 * Язык и клиент приходят из подписи токена, а не аргументом: аргументы пишет
 * модель. Аргумент один — темы.
 */
export const LINKEON_HELP_TOOL_NAME = 'linkeon_help';

const MAX_TOPICS = 3;
const MAX_RELATED = 5;
const logger = new Logger('LinkeonHelp');

export interface LinkeonHelpResult {
  ok: true;
  articles: { id: string; title: string; text: string }[];
  related: string[];
  /** Перечень тем — только когда статей нет. */
  index?: string;
}

/** Темы из того, что прислала модель: массив или одна строка; без повторов; только известные; не больше трёх. */
export function parseTopics(input: unknown, known: readonly string[]): string[] {
  const raw = (input as any)?.topics;
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const allowed = new Set(known);
  const out: string[] = [];
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const id = t.trim().toLowerCase();
    if (allowed.has(id) && !out.includes(id)) out.push(id);
    if (out.length === MAX_TOPICS) break;
  }
  return out;
}

export function executeLinkeonHelp(
  input: unknown,
  o: { lang: string; client: KbClient },
  registry: readonly KbArticle[] = KB_ARTICLES,
): LinkeonHelpResult {
  const avail = new Map(topicsFor(o.client, registry).map((a) => [a.id, a]));
  const articles: LinkeonHelpResult['articles'] = [];
  for (const id of parseTopics(input, [...avail.keys()])) {
    const a = avail.get(id)!;
    try {
      articles.push({ id, title: a.title, text: renderArticle(a, o.lang, o.client) });
    } catch (e: any) {
      // Ошибка в коде одной статьи не должна лишать ответа по остальным.
      logger.warn(`статья ${id} не собралась: ${e?.message}`);
    }
  }
  if (articles.length === 0) {
    return { ok: true, articles: [], related: [], index: renderIndex(o.client, registry) };
  }
  const asked = new Set(articles.map((a) => a.id));
  const related = [...new Set(articles.flatMap((a) => avail.get(a.id)!.related))]
    .filter((id) => !asked.has(id) && avail.has(id))
    .slice(0, MAX_RELATED);
  return { ok: true, articles, related };
}

/** Описание инструмента. Перечень тем — по клиенту: сборке из стора не показываем тем о деньгах. */
export function linkeonHelpTool(client: KbClient, registry: readonly KbArticle[] = KB_ARTICLES) {
  const ids = topicsFor(client, registry).map((a) => a.id);
  return {
    name: LINKEON_HELP_TOOL_NAME,
    description:
      'Справка о платформе Linkeon: как пользоваться разделами, лимиты и цены, что делать, если не работает, как устроено.\n' +
      'Зови, когда пользователь спрашивает о самой платформе — как сделать, сколько стоит, где найти, почему не работает, ' +
      'на чём работает, — и когда хочешь предложить функцию Linkeon. Отвечай по статье, а не по памяти: функции и цены меняются.\n' +
      `• topics — от 1 до ${MAX_TOPICS} тем из списка:\n${renderIndex(client, registry)}\n` +
      'Ответ: articles[] — id, title, text. В text подписи кнопок уже на языке пользователя: называй их дословно, как в «кавычках». ' +
      'related — соседние темы. Внутренностей (серверы, инструкции, ключи) в справке нет — и рассказывать о них нельзя.\n' +
      'userId и телефон не передавай: сервер уже знает, чей это разговор.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topics: {
          type: 'array',
          items: { type: 'string', enum: ids },
          minItems: 1,
          maxItems: MAX_TOPICS,
          description: 'Темы справки, от одной до трёх.',
        },
      },
      additionalProperties: false,
    },
  };
}
