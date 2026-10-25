import { neutralizeAtMentions } from '../common/agent-guards';

/**
 * Весь запрос к модели — инструкция и текст — уходит в CLI одним аргументом
 * `-p` (claude-cli.service.ts). Linux не принимает аргумент длиннее 128 КБ
 * (MAX_ARG_STRLEN): spawn бросает E2BIG, и вызов выглядит как «модель не
 * ответила» — пачка молча пропадает. Кириллица — два байта на букву, так что
 * восемь длинных разговоров предел уже переходят. Запас до предела — на
 * склейку инструкции с текстом в сервисе CLI.
 */
export const MAX_PROMPT_BYTES = 110_000;

/** Сколько байт займёт текст в аргументе CLI: UTF-8 после обезвреживания @-упоминаний, как в сервисе. */
export function promptBytes(text: string): number {
  return Buffer.byteLength(neutralizeAtMentions(text), 'utf8');
}
