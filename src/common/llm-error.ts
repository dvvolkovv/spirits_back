// Классификация ошибки LLM → тип сбоя + человекочитаемая причина.
// Живёт в common/, потому что её зовут и мониторинг (claude-health), и сам
// ClaudeCliService (решение о запасном пути на Qwen): common не должен
// зависеть от monitoring. Чистая функция, без side-effects.
//
// Главный кейс, который раньше был невидим мониторингу: «недельный лимит»
// Claude-подписки — весь AI платформы (ассистенты через r.linkeon.io + Юля +
// Маша + VPM/VMM) сидит на ней, поэтому её исчерпание = полная деградация продукта.
export type LlmOutageKind = 'weekly_limit' | 'rate_limit' | 'auth' | 'overloaded' | 'timeout' | 'other';

/** Фраза вида сбоя — без текста самой ошибки. Для пяти видов её же отдаёт
 *  classifyLlmError(...).human; у other там сырой текст, здесь — своя фраза. */
const KIND_PHRASES: Readonly<Record<LlmOutageKind, string>> = {
  weekly_limit: 'Исчерпан лимит Claude-подписки (недельный/использования)',
  rate_limit: 'Rate limit Claude (слишком много запросов)',
  auth: 'Сбой авторизации Claude (OAuth/API-ключ)',
  overloaded: 'Claude перегружен/временно недоступен',
  timeout: 'Таймаут вызова Claude',
  other: 'неизвестный сбой CLI',
};

export function classifyLlmError(msg: string): { kind: LlmOutageKind; human: string } {
  const m = String(msg || '').toLowerCase();
  if (/weekly limit|hit your .*limit|usage limit|limit .*reset|limit reached|исчерпан.*лимит|недельн/.test(m))
    return { kind: 'weekly_limit', human: KIND_PHRASES.weekly_limit };
  if (/rate limit|too many requests|\b429\b/.test(m))
    return { kind: 'rate_limit', human: KIND_PHRASES.rate_limit };
  if (/unauthorized|\b401\b|invalid api key|authentication|oauth|credential|not logged in|please run .*login/.test(m))
    return { kind: 'auth', human: KIND_PHRASES.auth };
  if (/overloaded|\b529\b|\b503\b|internal server|try again|temporarily/.test(m))
    return { kind: 'overloaded', human: KIND_PHRASES.overloaded };
  if (/timeout|timed out|deadline/.test(m))
    return { kind: 'timeout', human: KIND_PHRASES.timeout };
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

// Хвосты отказа CLI, которые можно показать, — белый список: время сброса
// лимита (3pm, 11:30am, 15:00, зона в скобках — только буквы и _/+-) и
// подсказка про вход. Регулярка привязана к обоим концам хвоста.
const REFUSAL_TAIL_RE = /^ · (?:resets (?:\d{1,2}(?::\d{2})?[ap]m|\d{1,2}:\d{2})(?: \([A-Za-z_/+-]+\))?|Please run \/login)$/;

/** Деталь отказа CLI для безопасного текста (spec 2026-11-02-safe-cli-errors):
 *  фраза отказа (CLI_REFUSAL_RE) и хвост из белого списка — « · resets
 *  <время>[ (<зона>)]» или « · Please run /login». looksLikeCliRefusal привязан
 *  только к началу: дальше до 300 знаков может идти ответ модели, поэтому
 *  любой другой хвост отбрасывается — остаётся только фраза. Не отказ — ''. */
export function refusalDetail(text: string): string {
  if (!looksLikeCliRefusal(text)) return '';
  const t = String(text).trim();
  const phrase = CLI_REFUSAL_RE.exec(t)?.[0] ?? '';
  const tail = t.slice(phrase.length);
  return REFUSAL_TAIL_RE.test(tail) ? phrase + tail : phrase;
}

// ── Безопасный текст ошибки CLI (spec 2026-11-02-safe-cli-errors) ──────────
// Сырой текст сбоя CLI (result, stdout, stderr, сообщение JSON.parse) несёт
// фрагменты разговоров: он только классифицируется внутри ClaudeCliService.
// Наружу (журналы, база, алерты) — вид сбоя, код ответа API, код выхода,
// диагностика CLI и текст отказа самого CLI.

/** Предел детали в безопасном тексте — как у релея (safeErrorDetail). */
const SAFE_DETAIL_MAX = 160;

// Строка диагностики CLI в errors[] — целиком «ключ=значение» с enum-подобными
// значениями: без пробелов, кавычек и переводов строк внутри значения. Та же
// регулярка, что у релея (relay-agent/llm-fallback.mjs, EDE_DIAGNOSTIC_RE):
// меняешь здесь — сверь там. Время линейное: ни в ключе, ни в значении нет ни
// пробела, ни «=», граница каждой пары однозначна (сторож — в llm-error.spec.ts).
const EDE_DIAGNOSTIC_RE = /^\[ede_diagnostic\](?: [a-z_]+=[A-Za-z0-9_.:-]*)*$/;

/** Строка «[ede_diagnostic] …» из errors[] события CLI — первая такая, только
 *  если целиком проходит строгую проверку (не прошла — дальше не ищем), не
 *  длиннее 160. Остальные errors[] не берутся никогда: там текст ошибки API и
 *  ошибки хода (стеки с путями файлов, цитаты запроса). Нет — ''. */
export function cliDiagnostic(errors: unknown): string {
  if (!Array.isArray(errors)) return '';
  const diag = errors.find((e) => typeof e === 'string' && e.startsWith('[ede_diagnostic]'));
  return typeof diag === 'string' && EDE_DIAGNOSTIC_RE.test(diag) ? diag.slice(0, SAFE_DETAIL_MAX) : '';
}

/** Сильнейший вид среди попыток — порядок проверок classifyLlmError. */
const KIND_PRIORITY: readonly LlmOutageKind[] = ['weekly_limit', 'rate_limit', 'auth', 'overloaded', 'timeout', 'other'];

/** Сводный вид сбоя цепочки попыток (итоговая ошибка runRaw); пусто — other. */
export function aggregateKind(kinds: readonly LlmOutageKind[]): LlmOutageKind {
  return KIND_PRIORITY.find((k) => kinds.includes(k)) ?? 'other';
}

/** Фиксированная фраза вида сбоя — для причины в алерте и админке: без текста
 *  ошибки и для other тоже. Незнакомый вид — как other. */
export function safeKindPhrase(kind: LlmOutageKind): string {
  return Object.prototype.hasOwnProperty.call(KIND_PHRASES, kind) ? KIND_PHRASES[kind] : KIND_PHRASES.other;
}

/** api_error_status, если это код ответа HTTP (целое 100–599); иначе undefined. */
export function apiErrorStatus(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : undefined;
}

const ERROR_CODE_RE = /^[A-Za-z0-9_]{1,40}$/;

/** Код ошибки для безопасного текста: код системной ошибки (ENOENT,
 *  ERR_INVALID_ARG_VALUE) или имя её класса (TypeError); не похоже на код —
 *  'Error'. Сообщение таких ошибок наружу не идёт: оно цитирует аргументы — у
 *  spawn с NUL в аргументе это начало промпта или значение env с ключом. */
export function safeErrorCode(e: unknown): string {
  const code = (e as any)?.code;
  if (typeof code === 'string' && ERROR_CODE_RE.test(code)) return code;
  const name = (e as any)?.name;
  if (typeof name === 'string' && ERROR_CODE_RE.test(name)) return name;
  return 'Error';
}

/**
 * Безопасный текст ошибки CLI: `claude CLI <what>: <kind>[, status N][, <detail>]`.
 * what — из фиксированного словаря вызывающего («ошибка», «код выхода N»,
 * «сигнал SIGxxx», «отказ», «неверный JSON (stdout N байт)», «не запустился
 * (<код>)», «сбой (<код>)»); status — только целое 100–599; detail —
 * диагностика CLI (cliDiagnostic) или отказ самого CLI (refusalDetail), одной
 * строкой и не длиннее 160.
 */
export function safeCliText(p: {
  what: string;
  kind: LlmOutageKind;
  status?: number;
  detail?: string;
}): string {
  const parts: string[] = [p.kind];
  const status = apiErrorStatus(p.status);
  if (status !== undefined) parts.push(`status ${status}`);
  const detail = String(p.detail ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, SAFE_DETAIL_MAX);
  if (detail) parts.push(detail);
  return `claude CLI ${p.what}: ${parts.join(', ')}`;
}
