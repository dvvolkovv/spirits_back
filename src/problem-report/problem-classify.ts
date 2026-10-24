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
 * Список — точные коды, НАЧАЛА наших сообщений проверки ввода (сверка —
 * startsWith) и регулярки, тоже заякоренные на начало строки. Текст
 * провайдера, пришедший ПОСЛЕ нашего префикса или внутри обёртки
 * («Omni generate failed: …», «Проверьте дату и время рождения: ${e.message}»),
 * сюда не попадает и остаётся сбоем. Каждая строка закреплена тестом в
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
  // RangeError от new Date / Intl, когда модель передала время не в ISO
  // (propose_calendar_event). Иначе ассистент сказал бы «команда в курсе»
  // про собственную опечатку.
  'invalid time value',
]);

/**
 * Начала наших сообщений проверки ввода (в нижнем регистре). Сверка — только с
 * НАЧАЛОМ строки: обёртки провайдеров («Omni generate failed: …», «Yandex TTS
 * 400: …», текст OpenAI как есть) кладут чужой текст после своего префикса, и
 * поиск подстроки где угодно глушил бы настоящий сбой провайдера
 * («… supports at most 2 reference images»).
 */
const USER_SIDE_PREFIXES = [
  // нет обязательного аргумента
  'missing prompt',
  'missing sourceimageurl',
  'sourceimageurl required',
  'banner requires at least',
  'compose_image requires at least',
  'veo requires a prompt',
  'image2video requires',
  'title обязателен',
  'from и to обязательны',
  'укажи ',
  'нужен ',
  'recurrence требует datetime',
  // значение вне правил
  'compose_image supports at most',
  'veo supports mode',
  'veo length must be',
  'unsupported video model',
  'recurrence.count должен быть',
  'dates не должен быть пустым',
  'dates: максимум',
  'некорректные даты периода',
  'конец периода должен быть позже',
  'период слишком большой',
  // hd-tool: только точные проверки. «Проверьте дату и время рождения: …»
  // оборачивает любое исключение расчёта (пояс, которого нет в ICU, NaN) — это сбой.
  'проверьте дату рождения:',
  'проверьте время рождения:',
  'дата рождения в будущем',
  'cityid не из вариантов',
  // ссылки и файлы от модели
  'ссылка не принята:',
  'invalid data url',
  'url did not return an image',
  'bad mime type',
  'file too large',
  // модерация запроса
  'запрос отклонён модерацией',
  // лимиты самого пользователя; «limit reached» без хвоста — это и 429 провайдера
  'too many concurrent jobs',
  'own voice not ready',
  'limit reached: не больше',
  // чужое, несуществующее или не в том состоянии
  'job not found',
  'not your job',
  'cannot delete active job',
];

/** Наши сообщения с переменной частью — регулярками, тоже от начала строки. */
const USER_SIDE_PATTERNS = [
  /^город «.*» не найден в базе/, // hd-tool: города нет в нашей базе
  // safe-fetch: модель выдумала адрес картинки. Сюда же попадёт любая ошибка
  // DNS-резолвера (включая таймаут и SERVFAIL нашего DNS) — это допустимо:
  // своё хранилище (MinIO) через DNS не ходит, а системный отказ DNS всплывёт
  // сбоем в вызовах провайдеров (getaddrinfo EAI_AGAIN …), которые этим
  // паттерном не перехватываются.
  /^адрес \S+ не найден$/,
  // Gemini отказал по модерации — так ответили на запрос пользователя, а не
  // поломка. IMAGE_RECITATION и пустой ответ без причины — сбой (флейк Google).
  /^модель не вернула изображени[йея] \((?:(?:image_)?(?:safety|prohibited_content)|blocklist|spii)\)/,
];

/** Смотрим только первые 2000 символов: дальше подпись и класс не меняются, а проход огромной строки дорог. */
export function isUserSideToolError(error: unknown): boolean {
  const e = String(error ?? '').slice(0, 2000).trim().toLowerCase();
  if (!e) return false;
  if (USER_SIDE_CODES.has(e)) return true;
  if (USER_SIDE_PREFIXES.some((p) => e.startsWith(p))) return true;
  return USER_SIDE_PATTERNS.some((re) => re.test(e));
}

/**
 * Подпись сбоя для склейки: инструмент плюс ошибка без того, что меняется от
 * вызова к вызову (адреса, id, числа). Ассистента в подписи нет: снятая
 * модель у Киры и у Романа — один сбой. Смотрим только первые 2000 символов:
 * дальше подпись и класс не меняются, а проход огромной строки дорог.
 */
export function failureSignature(tool: string, error: unknown): string {
  const norm = String(error ?? '')
    .slice(0, 2000)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/[0-9a-f]{12,}/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${tool}|${norm}`;
}
