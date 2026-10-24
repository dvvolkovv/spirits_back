/**
 * Сбой инструмента ассистента: виноват ли сервис.
 *
 * «Виноват не сервис» — нехватка токенов, неверные аргументы модели, лимиты
 * самого пользователя, чужое или несуществующее. Всё остальное — сбой, о
 * котором надо сказать команде (спека 2026-10-24-assistant-problem-reports).
 *
 * Неизвестное считается сбоем сознательно: лишнее сообщение склеится и
 * стоит дёшево, молчание — дорого. 24.10.2026 Кира дважды не смогла сделать
 * видео (Google снял модель), и команда не узнала.
 *
 * Список — точные коды и подстроки сообщений проверки ввода ИЗ НАШЕГО кода.
 * Текстов провайдеров здесь нет. Каждая строка закреплена тестом в
 * problem-classify.spec.ts; новая проверка ввода в инструменте — сюда и туда.
 */

/** Ответы-коды целиком. */
const USER_SIDE_CODES = new Set([
  'insufficient_tokens',
  'text_too_long',
  'empty_text',
  'empty text',
  'empty prompt',
  'rate_limited',
]);

/** Подстроки в нижнем регистре. */
const USER_SIDE_PHRASES = [
  // нет обязательного аргумента
  'missing prompt',
  'missing sourceimageurl',
  'sourceimageurl required',
  'requires at least',
  'requires a prompt',
  'requires sourceimageurl',
  'обязател',
  'укажи ',
  'нужен ',
  'требует datetime',
  // значение вне правил
  'supports at most',
  'supports mode',
  'length must be',
  'unsupported video model',
  'должен быть',
  'максимум',
  'некорректные даты',
  'проверьте ',
  'cityid не из вариантов',
  'не найден в базе',
  // ссылки и файлы от модели
  'ссылка не принята',
  'invalid data url',
  'did not return an image',
  'bad mime type',
  'file too large',
  // модерация запроса
  'отклонён модерацией',
  // лимиты самого пользователя — подстрока узкая: провайдеры тоже пишут
  // "rate limit reached" в текстах своих 429 (напр. OpenAI TTS в
  // speech.service.ts, который отдаёт текст провайдера как есть) — это сбой
  // провайдера, а не лимит пользователя, и с голой 'limit reached' склеилось
  // бы с ним. Наша проверка — только routine-store.service.ts: `limit
  // reached: не больше ${MAX_ROUTINES_PER_USER} рутин`.
  'too many concurrent jobs',
  'own voice not ready',
  'limit reached: не больше',
  // чужое, несуществующее или не в том состоянии
  'job not found',
  'not your job',
  'cannot delete active job',
];

export function isUserSideToolError(error: unknown): boolean {
  const e = String(error ?? '').trim().toLowerCase();
  if (!e) return false;
  if (USER_SIDE_CODES.has(e)) return true;
  return USER_SIDE_PHRASES.some((p) => e.includes(p));
}

/**
 * Подпись сбоя для склейки: инструмент плюс ошибка без того, что меняется от
 * вызова к вызову (адреса, id, числа). Ассистента в подписи нет: снятая
 * модель у Киры и у Романа — один сбой.
 */
export function failureSignature(tool: string, error: unknown): string {
  const norm = String(error ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${tool}|${norm}`;
}
