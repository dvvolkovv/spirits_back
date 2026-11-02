import {
  aggregateKind,
  classifyLlmError,
  cliDiagnostic,
  LlmOutageKind,
  looksLikeCliRefusal,
  refusalDetail,
  safeCliText,
  safeErrorCode,
  safeKindPhrase,
} from './llm-error';

/**
 * Отказ CLI, пришедший обычным ответом. Распознаётся только с начала текста:
 * ложное срабатывание здесь открывает окно запасного пути для всех вызовов,
 * а Маша часто говорит о ключах продуктов.
 */
describe('looksLikeCliRefusal', () => {
  it.each([
    'Not logged in · Please run /login',
    'Please run /login',
    "You've hit your session limit · resets 3am (UTC)",
    'You’ve hit your weekly limit · resets Nov 3',
    'You have hit your usage limit',
    'Invalid API key · Please run /login',
    'Credit balance is too low',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'Claude AI usage limit reached|1730000000',
    '  Not logged in · Please run /login\n',
    "You've hit your limit · resets 3am",
    "You've hit your Opus limit",
  ])('отказ: %p', (t) => {
    expect(looksLikeCliRefusal(t)).toBe(true);
  });

  it.each([
    'Это значит, что ключ неверный: сервис ответил Invalid API key. Проверьте ключ в карточке продукта.',
    'У меня выскочило «Not logged in», что делать?',
    'Похоже, вы hit your usage limit у провайдера — подождите сброса.',
    // Отказы CLI всегда английские: русский ответ Маши, начатый с цитаты, — не отказ.
    'Invalid API key — так ответил сервис, проверьте ключ',
    '',
    'Not logged in · Please run /login ' + 'x'.repeat(300),
  ])('не отказ: %p', (t) => {
    expect(looksLikeCliRefusal(t)).toBe(false);
  });
});

/**
 * Безопасный текст ошибки CLI (spec 2026-11-02-safe-cli-errors, раздел 2):
 * наружу — вид сбоя, код ответа API, код выхода и служебная диагностика CLI;
 * сырой текст (result, stdout, stderr) — только внутри, для классификации.
 */
describe('cliDiagnostic', () => {
  // Так errors[] собирает CLI 2.1.x: первой — диагностика, дальше — ошибки хода
  // (error.stack || error.message: пути файлов, цитаты запроса).
  const DIAG = '[ede_diagnostic] result_type=user last_content_type=tool_result stop_reason=null';

  it('строка [ede_diagnostic] из errors[] — как есть, и не первым элементом тоже', () => {
    expect(cliDiagnostic([DIAG, 'Error: СЕКРЕТ-ИЗ-ОТВЕТА'])).toBe(DIAG);
    expect(cliDiagnostic(['Error: СЕКРЕТ-ИЗ-ОТВЕТА', DIAG])).toBe(DIAG);
    expect(cliDiagnostic(['[ede_diagnostic]'])).toBe('[ede_diagnostic]');
  });

  it('длинная — не длиннее 160', () => {
    const long = '[ede_diagnostic]' + ' k=v'.repeat(100);
    expect(cliDiagnostic([long])).toBe(long.slice(0, 160));
  });

  it('не строки в errors[] пропускаются, диагностика за ними находится', () => {
    expect(cliDiagnostic([null, 42, { code: 'E1' }, ['x'], DIAG])).toBe(DIAG);
  });

  it.each([undefined, null, 42, DIAG, { 0: DIAG, length: 1 }])('не массив — пусто: %p', (v) => {
    expect(cliDiagnostic(v)).toBe('');
  });

  it('без диагностики — пусто: остальные errors[] не берутся', () => {
    expect(cliDiagnostic([])).toBe('');
    expect(cliDiagnostic(['Error: СЕКРЕТ-ИЗ-ОТВЕТА', 'ede_diagnostic a=b'])).toBe('');
  });

  it.each([
    '[ede_diagnostic] a=/home/u/doc.pdf',
    '[ede_diagnostic] a=x@y.ru',
    '[ede_diagnostic] a=b=c',
    '[ede_diagnostic] a=привет',
    '[ede_diagnostic] any text=x',
    '[ede_diagnostic] A=1',
    '[ede_diagnostic] result_type=user stop_reason=null ',
    '[ede_diagnostic] result_type=user\nstop_reason=null',
    '[ede_diagnostic] result_type="user" stop_reason=null',
    "[ede_diagnostic] result_type=it's",
    '[ede_diagnostic]a=1',
    '[ede_diagnostic] a=СЕКРЕТ-ИЗ-ОТВЕТА',
  ])('не проходит строгую проверку целиком — пусто: %p', (bad) => {
    expect(cliDiagnostic([bad])).toBe('');
  });

  it('первая строка [ede_diagnostic] не прошла — дальше не ищем', () => {
    expect(cliDiagnostic(['[ede_diagnostic] a=x@y.ru', DIAG])).toBe('');
  });

  // Сторож на время — по процессорному, не настенному: вытеснение процесса на
  // общей ноде дало бы ложный красный. Обычно — единицы мс.
  it('длинные строки — без зависания (сторож по процессорному времени)', () => {
    const valid = '[ede_diagnostic]' + ' a=b'.repeat(25_000);
    const longValue = '[ede_diagnostic] a=' + 'b'.repeat(1e5);
    const cases: Array<[string, string]> = [
      [' '.repeat(1e5), ''],
      ['[ede_diagnostic]' + ' '.repeat(1e5) + 'x', ''],
      ['[ede_diagnostic]' + ' a=b'.repeat(25_000) + '!', ''],
      ['[ede_diagnostic] a=' + 'b'.repeat(1e5) + ' ', ''],
      [valid, valid.slice(0, 160)],
      [longValue, longValue.slice(0, 160)],
    ];
    for (const [s, want] of cases) {
      const c0 = process.cpuUsage();
      const got = cliDiagnostic([s]);
      const { user, system } = process.cpuUsage(c0);
      expect(got).toBe(want);
      expect((user + system) / 1000).toBeLessThan(200);
    }
  });
});

describe('aggregateKind', () => {
  it.each<[LlmOutageKind[], LlmOutageKind]>([
    [['auth', 'weekly_limit', 'other'], 'weekly_limit'],
    [['overloaded', 'rate_limit', 'auth'], 'rate_limit'],
    [['other', 'timeout', 'auth', 'overloaded'], 'auth'],
    [['timeout', 'overloaded', 'other'], 'overloaded'],
    [['other', 'timeout'], 'timeout'],
    [['other', 'other'], 'other'],
    [['auth'], 'auth'],
  ])('%p → %s', (kinds, want) => {
    expect(aggregateKind(kinds)).toBe(want);
  });

  it('порядок попыток не важен', () => {
    expect(aggregateKind(['timeout', 'weekly_limit'])).toBe('weekly_limit');
    expect(aggregateKind(['weekly_limit', 'timeout'])).toBe('weekly_limit');
  });

  it('пусто — other', () => {
    expect(aggregateKind([])).toBe('other');
  });
});

describe('safeKindPhrase', () => {
  it.each<[LlmOutageKind, string]>([
    ['weekly_limit', "You've hit your weekly limit · resets Nov 3"],
    ['rate_limit', 'API Error: 429 Too Many Requests'],
    ['auth', 'Failed to authenticate. API Error: 401'],
    ['overloaded', 'API Error: 529 Overloaded'],
    ['timeout', 'claude CLI timeout after 5ms'],
  ])('%s — та же фраза, что у classifyLlmError', (kind, raw) => {
    const c = classifyLlmError(raw);
    expect(c.kind).toBe(kind);
    expect(safeKindPhrase(kind)).toBe(c.human);
  });

  it('other — фиксированная фраза, а не текст ошибки (у classifyLlmError там сырой текст)', () => {
    expect(classifyLlmError('СЕКРЕТ-ИЗ-ОТВЕТА').human).toContain('СЕКРЕТ-ИЗ-ОТВЕТА');
    expect(safeKindPhrase('other')).toBe('неизвестный сбой CLI');
  });
});

describe('safeCliText', () => {
  it('только вид', () => {
    expect(safeCliText({ what: 'ошибка', kind: 'other' })).toBe('claude CLI ошибка: other');
  });

  it('вид, статус, деталь — по порядку через «, »', () => {
    expect(safeCliText({ what: 'ошибка', kind: 'auth', status: 401, detail: '[ede_diagnostic] a=b' }))
      .toBe('claude CLI ошибка: auth, status 401, [ede_diagnostic] a=b');
    expect(safeCliText({ what: 'код выхода 1', kind: 'overloaded', status: 529 }))
      .toBe('claude CLI код выхода 1: overloaded, status 529');
  });

  it('status — только целое 100–599', () => {
    expect(safeCliText({ what: 'ошибка', kind: 'other', status: 100 })).toBe('claude CLI ошибка: other, status 100');
    expect(safeCliText({ what: 'ошибка', kind: 'other', status: 599 })).toBe('claude CLI ошибка: other, status 599');
    for (const st of [99, 600, 500.5, NaN, Infinity, -401, '500', null, undefined, true, {}] as any[]) {
      expect(safeCliText({ what: 'ошибка', kind: 'other', status: st })).toBe('claude CLI ошибка: other');
    }
  });

  it('деталь — одной строкой: переводы строк → пробел', () => {
    expect(safeCliText({ what: 'отказ', kind: 'weekly_limit', detail: "  You've hit your limit\n· resets 3pm\r\n(UTC)\n" }))
      .toBe("claude CLI отказ: weekly_limit, You've hit your limit · resets 3pm (UTC)");
  });

  it('деталь — не длиннее 160', () => {
    expect(safeCliText({ what: 'отказ', kind: 'other', detail: 'x'.repeat(500) }))
      .toBe(`claude CLI отказ: other, ${'x'.repeat(160)}`);
  });

  it('пустая деталь не пишется', () => {
    for (const d of ['', '   ', '\n\r\n', undefined, null] as any[]) {
      expect(safeCliText({ what: 'ошибка', kind: 'auth', status: 401, detail: d })).toBe('claude CLI ошибка: auth, status 401');
    }
  });
});

/**
 * Деталь отказа CLI (ревью 02.11, I1): looksLikeCliRefusal привязан только к
 * началу текста, дальше до 300 знаков может идти ответ модели. В безопасный
 * текст — только фраза отказа и хвост из белого списка (время сброса лимита,
 * подсказка про вход); любой другой хвост отбрасывается.
 */
describe('refusalDetail', () => {
  it.each([
    "You've hit your limit · resets 3pm (Europe/Moscow)",
    "You've hit your session limit · resets 3am (UTC)",
    'You’ve hit your weekly limit · resets 11:30am',
    "You've hit your limit · resets 15:00",
    "You've hit your limit · resets 9:05pm (America/New_York)",
    // Дата сброса: месяц — три буквы с заглавной, день — одна-две цифры; дальше
    // время через пробел или «, » и зона — как у одного времени.
    "You've hit your weekly limit · resets Nov 3",
    "You've hit your weekly limit · resets Nov 3, 11am (Europe/Moscow)",
    "You've hit your weekly limit · resets Nov 3 11am",
    "You've hit your weekly limit · resets Nov 3 (UTC)",
    'You’ve hit your weekly limit · resets Dec 15, 3:30pm',
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
    'Please run /login',
    'Credit balance is too low',
    "You've hit your Opus limit",
  ])('фраза отказа и хвост из белого списка — целиком: %p', (t) => {
    expect(refusalDetail(t)).toBe(t);
  });

  it('пробелы и переводы строк по краям не мешают', () => {
    expect(refusalDetail('  Not logged in · Please run /login\n')).toBe('Not logged in · Please run /login');
  });

  it.each([
    ['Invalid API key means the token SECRET-FROM-ANSWER is wrong', 'Invalid API key'],
    ["You've hit your limit · resets 3pm (Europe/Moscow) SECRET-FROM-ANSWER", "You've hit your limit"],
    ["You've hit your limit · resets soon, SECRET-FROM-ANSWER", "You've hit your limit"],
    ['Not logged in · Please run /login SECRET-FROM-ANSWER', 'Not logged in'],
    ['Not logged in SECRET-FROM-ANSWER · Please run /login', 'Not logged in'],
    // После даты — только время и зона; латинский текст ответа — нет.
    ["You've hit your weekly limit · resets Nov 3 SECRET-FROM-ANSWER", "You've hit your weekly limit"],
    ["You've hit your weekly limit · resets Nov 3, SECRET-FROM-ANSWER", "You've hit your weekly limit"],
    ["You've hit your weekly limit · resets Nov 3, 11am SECRET-FROM-ANSWER", "You've hit your weekly limit"],
    // Строгий формат даты: запятая — только с пробелом, месяц — ровно три
    // буквы с заглавной, год — не время.
    ["You've hit your weekly limit · resets Nov 3,11am", "You've hit your weekly limit"],
    ["You've hit your weekly limit · resets November 3", "You've hit your weekly limit"],
    ["You've hit your weekly limit · resets nov 3", "You've hit your weekly limit"],
    ["You've hit your weekly limit · resets Nov 3, 2026", "You've hit your weekly limit"],
    // Зона — только буквы и _/+-; цифры (UTC+3) — уже не зона.
    ["You've hit your limit · resets 3pm (UTC+3)", "You've hit your limit"],
    // Время — с am/pm или с минутами; голое число — нет.
    ["You've hit your limit · resets 3 (UTC)", "You've hit your limit"],
    ['Claude AI usage limit reached|1730000000', 'Claude AI usage limit reached'],
    ['OAuth token has expired. Please obtain a new token or refresh your existing token.', 'OAuth token has expired'],
  ])('иной хвост отбрасывается — только фраза: %p', (t, want) => {
    expect(refusalDetail(t)).toBe(want);
  });

  it.each([
    '',
    'обычный ответ модели',
    'Это значит, что ключ неверный: сервис ответил Invalid API key.',
    'Invalid API key — так ответил сервис, проверьте ключ',
    'Not logged in · Please run /login ' + 'x'.repeat(300),
  ])('не отказ CLI — пусто: %p', (t) => {
    expect(refusalDetail(t)).toBe('');
  });
});

/**
 * Код ошибки для безопасного текста (ревью 02.11, I2): сообщения системных
 * ошибок цитируют аргументы — у spawn с NUL в аргументе это начало промпта
 * или значение env с ключом. Наружу — только код (ENOENT,
 * ERR_INVALID_ARG_VALUE) или имя класса ошибки.
 */
describe('safeErrorCode', () => {
  it('код системной ошибки', () => {
    expect(safeErrorCode(Object.assign(new Error('spawn /usr/bin/claude ENOENT'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(safeErrorCode(Object.assign(new TypeError("Received 'СЕКРЕТ-ИЗ-ОТВЕТА'"), { code: 'ERR_INVALID_ARG_VALUE' })))
      .toBe('ERR_INVALID_ARG_VALUE');
  });

  it('без кода — имя класса ошибки', () => {
    expect(safeErrorCode(new TypeError('СЕКРЕТ-ИЗ-ОТВЕТА'))).toBe('TypeError');
    expect(safeErrorCode(new Error('СЕКРЕТ-ИЗ-ОТВЕТА'))).toBe('Error');
  });

  it('код или имя не похожи на код — Error', () => {
    expect(safeErrorCode(Object.assign(new Error('x'), { code: 'not a code СЕКРЕТ' }))).toBe('Error');
    expect(safeErrorCode({ name: 'SECRET FROM ANSWER', message: 'x' })).toBe('Error');
    expect(safeErrorCode({ code: 42, name: 'x'.repeat(100) })).toBe('Error');
  });

  it.each([undefined, null, 'СЕКРЕТ-ИЗ-ОТВЕТА', 42])('не ошибка — Error: %p', (v) => {
    expect(safeErrorCode(v)).toBe('Error');
  });
});
