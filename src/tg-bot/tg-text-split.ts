/**
 * Нарезка текста под лимит Telegram.
 *
 * sendMessage не принимает больше 4096 символов и отвечает 400 «message is too
 * long». В tg-bot.service.ts ошибка вылетала из handleGroupMessage наружу — до
 * persistAssistantReply и списания токенов дело не доходило, ответ Claude
 * терялся целиком, а юзер видел молчание (статус «🤔 Думаю…» к этому моменту
 * уже удалён). Мониторинг ловил такие чаты по answer_expected_at.
 *
 * Лимит Telegram считает в UTF-16 code units — ровно то же, что String.length
 * в JS, поэтому дополнительного пересчёта не нужно. А вот резать между
 * половинами суррогатной пары нельзя: получится битый UTF-8.
 */

export const TELEGRAM_TEXT_LIMIT = 4096;

/** Слишком ранний разрыв дробит ответ в труху — лучше жёсткий рез ближе к концу. */
const MIN_FILL_RATIO = 0.5;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Позиция конца куска (exclusive) для остатка длиннее лимита. */
function breakPoint(rest: string, limit: number): number {
  const window = rest.slice(0, limit);
  const minFill = Math.floor(limit * MIN_FILL_RATIO);

  for (const sep of ['\n\n', '\n', ' ']) {
    const idx = window.lastIndexOf(sep);
    if (idx >= minFill) return idx;
  }

  // Разрывать нечего (сплошной текст без пробелов) — режем по лимиту, отступая
  // на символ, если он оказался старшей половиной суррогатной пары.
  const cut = limit;
  return isHighSurrogate(rest.charCodeAt(cut - 1)) ? cut - 1 : cut;
}

/**
 * Режет текст на куски не длиннее limit. Пробельный разделитель на месте
 * разрыва съедается, значимые символы не теряются. Пустой (или чисто
 * пробельный) текст даёт пустой массив — отправлять нечего.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > limit) {
    const cut = breakPoint(rest, limit);
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);
  return chunks;
}
