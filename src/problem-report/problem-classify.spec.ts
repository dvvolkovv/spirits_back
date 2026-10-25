import { failureSignature, isUserSideToolError } from './problem-classify';

/**
 * Каждая строка — настоящее сообщение инструментов Linkeon (chat-tools.ts,
 * misc.service.ts, video.service.ts, speech.service.ts, calendar.service.ts,
 * routine-store.service.ts, hd-tool.service.ts) или провайдера.
 *
 * Отдельная группа строк в «сбой» — гипотетические тексты провайдера вида
 * «Omni generate failed: … supports at most …», «… Video length must be …»,
 * «Yandex TTS 400: …»: таких сообщений на момент написания в логах не было,
 * они здесь, чтобы застраховать от возврата к поиску подстроки где угодно
 * (вместо только начала строки) — такой поиск склеил бы чужой текст,
 * пришедший после своего префикса, с нашей проверкой ввода.
 */
describe('isUserSideToolError: виноват ли не сервис', () => {
  // Сбои — о них команда должна узнать.
  it.each([
    'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available. Please update your code to use models/gemini-omni-1.1-flash for the latest features and improvements.',
    'Модель не вернула изображений (IMAGE_RECITATION). Попробуйте ещё раз или измените промпт.',
    'Модель не вернула изображение',
    'Google не успел обработать картинку за 5 минут. Попробуйте повторить — обычно помогает.',
    'tts failed',
    'tts_failed',
    'Инструмент расчёта временно недоступен — посчитайте прежним способом.',
    'Veo is not configured (GOOGLE_AI_API_KEY)',
    'Google AI API key not configured',
    'Veo: на сегодня исчерпан дневной лимит генераций видео. Лимит обновляется раз в сутки около 10:00–11:00 МСК — попробуйте позже. (админу: повысить квоту Veo для ключа в Google AI Studio / Cloud Console.)',
    'tool execution failed',
    'unknown tool: generate_kling',
    'image generation failed',
    'не удалось прочитать календарь',
    'connect ECONNREFUSED 127.0.0.1:5433',
    'timeout of 30000ms exceeded',
    '429 Rate limit reached for tts-1 in organization org-test on requests per min (RPM): Limit 50, Used 50, Requested 1.',
    'Omni generate failed: Internal error encountered.',
    'Видео: временный лимит частоты запросов. Можно повторить примерно через 57 сек.',
    'Видео: на сегодня исчерпан дневной лимит генераций видео. Лимит обновляется раз в сутки около 10:00–11:00 МСК — попробуйте позже. (админу: повысить квоту Gemini Omni для ключа в Google AI Studio / Cloud Console.)',
    'Omni generate failed: reference_to_video supports at most 2 reference images',
    'Omni generate failed: Video length must be between 3s and 10s',
    'Yandex TTS 400: {"error":"text length must be less than 5000"}',
    'Проверьте дату и время рождения: Invalid time zone specified: Europe/Kyiv',
    'CALENDAR_SECRET_KEY must be >= 32 chars',
    'OPENAI_API_KEY not configured',
    'banner generation failed',
    'image edit failed',
    'image compose failed',
    'upscale failed',
    'Veo: не удалось запустить генерацию',
    'Google не успел обработать картинки за 5 минут. Попробуйте повторить — обычно помогает.',
    'превышено время ожидания (30 с)',
    'сервер ответил кодом 503',
    // edit_image/compose_image/upscale_image качают исходник через safe-fetch,
    // и это обычно наш MinIO: 403 (сбитая политика бакета после пересборки —
    // уже был прецедент) или 404 (потерянный объект) — наш сбой, не ошибка
    // модели, даже если текст совпадает с «модель дала мёртвую ссылку».
    'сервер ответил кодом 403',
    'сервер ответил кодом 404',
  ])('сбой: %s', (error) => {
    expect(isUserSideToolError(error)).toBe(false);
  });

  // Виноват не сервис — в группу не идёт.
  it.each([
    'insufficient_tokens',
    'empty prompt',
    'empty text',
    'empty_text',
    'text_too_long',
    'rate_limited',
    'Missing prompt',
    'Missing sourceImageUrl',
    'sourceImageUrl required',
    'banner requires at least title, subtitle or cta',
    'compose_image requires at least 2 sourceImageUrls',
    'compose_image supports at most 3 sourceImageUrls',
    'Veo requires a prompt',
    'image2video requires sourceImageUrl(s)',
    'Veo supports mode text2video or image2video',
    'Veo length must be 4–60 seconds',
    'unsupported video model: kling-v1-6 (only veo-3.1-fast, veo-3.1)',
    'too many concurrent jobs — wait for one to finish',
    'own voice not ready — upload a voice sample first',
    'title обязателен',
    'from и to обязательны (период чтения календаря)',
    'Укажи ровно один способ времени для события: datetime (разово), recurrence (регулярный повтор) или dates (набор дат)',
    'Укажи assistant — своё имя ассистента (например "Райя"), чтобы привязать рутину к тебе.',
    'recurrence требует datetime — время первого вхождения серии',
    'recurrence.count должен быть целым числом от 1 до 100',
    'dates не должен быть пустым',
    'dates: максимум 100 элементов',
    'некорректные даты периода',
    'конец периода должен быть позже начала',
    'период слишком большой (максимум 366 дней)',
    'Нужен город рождения.',
    'Нужен хотя бы заголовок, подзаголовок или CTA',
    'Проверьте дату рождения: формат ГГГГ-ММ-ДД, существующий день.',
    'Проверьте время рождения: формат ЧЧ:ММ.',
    'Дата рождения в будущем — проверьте год.',
    'cityId не из вариантов прошлого ответа — вызовите без cityId.',
    'Город «Куйбышев» не найден в базе. Передайте нынешнее официальное название',
    'ссылка не принята: адрес ведёт во внутреннюю сеть',
    'Invalid data URL',
    'URL did not return an image',
    'bad mime type for image: text/html',
    'file too large (max 10 MB)',
    'Запрос отклонён модерацией — попробуйте переформулировать',
    'limit reached: не больше 10 рутин',
    'job not found',
    'not your job',
    'cannot delete active job — wait for completion',
    'Укажи ровно одно из recurrence.count или recurrence.until',
    'Invalid time value',
    'адрес example.invalid не найден',
    'Модель не вернула изображений (IMAGE_SAFETY). Попробуйте ещё раз или измените промпт.',
    'Модель не вернула изображений (PROHIBITED_CONTENT). Попробуйте ещё раз или измените промпт.',
    'Модель не вернула изображений (IMAGE_PROHIBITED_CONTENT). Попробуйте ещё раз или измените промпт.',
  ])('не сбой: %s', (error) => {
    expect(isUserSideToolError(error)).toBe(true);
  });

  it('пустая или отсутствующая ошибка — сбой: неизвестное не глушим', () => {
    expect(isUserSideToolError('')).toBe(false);
    expect(isUserSideToolError(undefined)).toBe(false);
  });
});

describe('failureSignature: подпись для склейки', () => {
  it('числа, id и адреса не плодят подписей', () => {
    const a = failureSignature('generate_video', 'job 3f2b9c1e-1111-4a2b-9c3d-123456789abc failed after 37s, see https://x.y/op/123');
    const b = failureSignature('generate_video', 'job 9a8b7c6d-2222-4b3c-8d4e-abcdefabcdef failed after 41s, see https://x.y/op/987');
    expect(a).toBe(b);
  });

  it('разные инструменты — разные подписи', () => {
    expect(failureSignature('generate_video', 'boom')).not.toBe(failureSignature('generate_image', 'boom'));
  });

  it('разные ошибки — разные подписи', () => {
    expect(failureSignature('generate_video', 'quota exceeded'))
      .not.toBe(failureSignature('generate_video', 'model is no longer available'));
  });

  it('регистр и пробелы не важны', () => {
    expect(failureSignature('t', 'Model  Is\nGone')).toBe(failureSignature('t', 'model is gone'));
  });

  it('длинная ошибка обрезается: подпись — инструмент и не больше 160 символов', () => {
    expect(failureSignature('t', 'x'.repeat(1000)).length).toBeLessThanOrEqual('t|'.length + 160);
  });

  it('адреса с разными нецифровыми частями — одна подпись', () => {
    expect(failureSignature('t', 'see https://a.example/op/abc'))
      .toBe(failureSignature('t', 'see https://b.example/x/def'));
  });

  it('длинный hex-id без дефисов — одна подпись', () => {
    expect(failureSignature('t', 'request 0123456789abcdef0123 failed'))
      .toBe(failureSignature('t', 'request fedcba9876543210fedc failed'));
  });

  it('hex-id, приклеенный к префиксу (req_…), — одна подпись', () => {
    expect(failureSignature('t', 'OpenAI 500 (request id req_0123456789abcdef0123456789abcdef)'))
      .toBe(failureSignature('t', 'OpenAI 500 (request id req_fedcba9876543210fedcba9876543210)'));
  });

  it('огромная ошибка: смотрим только начало', () => {
    const huge = 'x'.repeat(10_000_000);
    expect(isUserSideToolError(huge)).toBe(false);
    expect(isUserSideToolError('insufficient_tokens' + ' '.repeat(3000))).toBe(true);
    expect(failureSignature('t', huge).length).toBeLessThanOrEqual('t|'.length + 160);
    // Без среза trim дошёл бы до кода в хвосте и вернул true.
    expect(isUserSideToolError(' '.repeat(2000) + 'insufficient_tokens')).toBe(false);
    // Без среза в подпись попал бы хвост « tail».
    expect(failureSignature('t', 'z'.repeat(100) + ' '.repeat(1900) + 'tail')).toBe('t|' + 'z'.repeat(100));
  });
});
