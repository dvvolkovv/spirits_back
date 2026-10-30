// Классификация ошибки LLM → тип сбоя + человекочитаемая причина.
// Живёт в common/, потому что её зовут и мониторинг (claude-health), и сам
// ClaudeCliService (решение о запасном пути на Qwen): common не должен
// зависеть от monitoring. Чистая функция, без side-effects.
//
// Главный кейс, который раньше был невидим мониторингу: «недельный лимит»
// Claude-подписки — весь AI платформы (ассистенты через r.linkeon.io + Юля +
// Маша + VPM/VMM) сидит на ней, поэтому её исчерпание = полная деградация продукта.
export type LlmOutageKind = 'weekly_limit' | 'rate_limit' | 'auth' | 'overloaded' | 'timeout' | 'other';
export function classifyLlmError(msg: string): { kind: LlmOutageKind; human: string } {
  const m = String(msg || '').toLowerCase();
  if (/weekly limit|hit your .*limit|usage limit|limit .*reset|limit reached|исчерпан.*лимит|недельн/.test(m))
    return { kind: 'weekly_limit', human: 'Исчерпан лимит Claude-подписки (недельный/использования)' };
  if (/rate limit|too many requests|\b429\b/.test(m))
    return { kind: 'rate_limit', human: 'Rate limit Claude (слишком много запросов)' };
  if (/unauthorized|\b401\b|invalid api key|authentication|oauth|credential|not logged in|please run .*login/.test(m))
    return { kind: 'auth', human: 'Сбой авторизации Claude (OAuth/API-ключ)' };
  if (/overloaded|\b529\b|\b503\b|internal server|try again|temporarily/.test(m))
    return { kind: 'overloaded', human: 'Claude перегружен/временно недоступен' };
  if (/timeout|timed out|deadline/.test(m))
    return { kind: 'timeout', human: 'Таймаут вызова Claude' };
  return { kind: 'other', human: msg ? String(msg).slice(0, 160) : 'Неизвестная ошибка LLM' };
}

/** Отказ CLI, пришедший обычным ответом (без is_error): короткая строка про вход или лимит.
 *  Набор фраз — на основе FATAL_RE релея (relay-agent/server.mjs) и looksCliFailure чата, но,
 *  в отличие от них, привязан к началу: здесь ложное срабатывание открывает окно для всех
 *  вызовов, а не портит один ход. Настоящий отказ CLI всегда начинается с фразы отказа.
 *  «Credit balance is too low» распознаётся, но classifyLlmError относит его к other — повтора
 *  на Qwen нет: это ключ API-биллинга, к OAuth-подписке отношения не имеет. */
export const CLI_REFUSAL_RE = /^(?:Not logged in|Please run \/login|(?:You['’]ve |You have )?hit your (?:\w+ )?limit|Invalid API key|Credit balance is too low|OAuth token (?:has )?expired|Claude AI usage limit reached)/i;
/** Отказы CLI всегда английские: короткий русский ответ, начатый с цитаты
 *  («Invalid API key — так ответил сервис…»), — не отказ. */
export function looksLikeCliRefusal(text: string): boolean {
  const t = (text || '').trim();
  return !!t && t.length <= 300 && !/[а-яё]/i.test(t) && CLI_REFUSAL_RE.test(t);
}
