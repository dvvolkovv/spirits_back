import { maskSecrets, SECRET_MASK } from './prompt-secrets';

/**
 * Значения ключей в этом файле СОБИРАЮТСЯ во время прогона, а не лежат
 * строками. Репозиторий публичный: готовая строка `ghp_…` или `sk-…` нужной
 * длины в исходнике — это находка для сканеров секретов GitHub (отказ пуша,
 * письма провайдерам), хотя ключ и выдуманный.
 */
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function tok(n: number, seed = 7, alphabet = ALNUM): string {
  // Детерминированный разброс: тест должен падать одинаково на каждом прогоне.
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  // Гарантия смеси классов: без неё короткий токен мог бы выйти без цифры.
  return out.slice(0, n - 3) + 'aZ7';
}
const join = (...parts: string[]) => parts.join('');

describe('maskSecrets: что скрывается', () => {
  it('строка «ИМЯ=значение»: значение скрыто, имя осталось и попало в names', () => {
    const r = maskSecrets(`Подключи погоду: WEATHER_API_KEY=${tok(32)} и покажи прогноз`);
    expect(r.text).toBe(`Подключи погоду: WEATHER_API_KEY=${SECRET_MASK} и покажи прогноз`);
    expect(r.count).toBe(1);
    expect(r.names).toEqual(['WEATHER_API_KEY']);
  });

  it('формы присваивания: двоеточие, кавычки, JSON, export, camelCase', () => {
    const v = tok(24, 11);
    for (const [line, name] of [
      [`API_TOKEN: ${v}`, 'API_TOKEN'],
      [`export DB_PASSWORD="${v}"`, 'DB_PASSWORD'],
      [`{"clientSecret": "${v}"}`, 'clientSecret'],
      [`apiKey = '${v}'`, 'apiKey'],
      [`x-api-key: ${v}`, 'x-api-key'],
    ] as const) {
      const r = maskSecrets(line);
      expect(r.text).not.toContain(v);
      expect(r.text).toContain(SECRET_MASK);
      expect(r.names).toEqual([name]);
    }
  });

  it('известные форматы — без имени рядом', () => {
    const samples = [
      join('sk-', 'proj-', tok(40, 1)),
      join('sk-', 'ant-', 'api03-', tok(40, 2)),
      join('sk', '_live_', tok(24, 3)),
      join('gh', 'p_', tok(36, 4)),
      join('github', '_pat_', tok(40, 5)),
      join('gl', 'pat-', tok(20, 6)),
      join('xo', 'xb-', tok(24, 7)),
      join('AK', 'IA', tok(16, 8, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567').toUpperCase().replace(/[^A-Z0-9]/g, 'Q').slice(0, 16)),
      join('AI', 'za', tok(35, 9)),
      join('ya', '29.', tok(40, 10)),
      join('y0', '_', tok(40, 11)),
      join('AQ', 'VN', tok(36, 12)),
      join('hf', '_', tok(34, 13)),
      join('gs', 'k_', tok(40, 14)),
      join('SG.', tok(22, 15), '.', tok(43, 16)),
      join('live', '_', tok(40, 17)),
    ];
    for (const s of samples) {
      const r = maskSecrets(`ключ ${s} вставь в код`);
      expect({ s, text: r.text }).toEqual({ s, text: `ключ ${SECRET_MASK} вставь в код` });
      expect(r.count).toBe(1);
      expect(r.names).toEqual([]);
    }
  });

  it('токен Telegram-бота', () => {
    const t = join('7234567890', ':', 'AA', tok(33, 21));
    const r = maskSecrets(`токен бота ${t}`);
    expect(r.text).toBe(`токен бота ${SECRET_MASK}`);
  });

  it('JWT и Bearer', () => {
    const jwt = join('ey', 'J', tok(20, 31), '.', 'ey', 'J', tok(30, 32), '.', tok(43, 33));
    expect(maskSecrets(`Authorization: Bearer ${jwt}`).text).toBe(`Authorization: Bearer ${SECRET_MASK}`);
    expect(maskSecrets(`заголовок Bearer ${tok(40, 34)}`).text).toBe(`заголовок Bearer ${SECRET_MASK}`);
    expect(maskSecrets(`вот токен ${jwt}`).text).toBe(`вот токен ${SECRET_MASK}`);
  });

  it('пароль в адресе: скрыт только пароль', () => {
    const r = maskSecrets(`подключись к postgres://shop:${tok(16, 41)}@db.example.com:5432/shop`);
    expect(r.text).toBe(`подключись к postgres://shop:${SECRET_MASK}@db.example.com:5432/shop`);
  });

  it('закрытый ключ PEM — целиком, и обрезанный тоже', () => {
    const body = `${tok(64, 51)}\n${tok(64, 52)}\n${tok(20, 53)}==`;
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(maskSecrets(`ключ сервиса:\n${pem}\nспасибо`).text).toBe(`ключ сервиса:\n${SECRET_MASK}\nспасибо`);
    const cut = `-----BEGIN RSA PRIVATE KEY-----\n${body}`;
    expect(maskSecrets(`вот: ${cut}`).text).toBe(`вот: ${SECRET_MASK}`);
  });

  it('русские «пароль:», «токен:», «ключ:»', () => {
    const v = join('Qw', '3rty', '!', tok(6, 61));
    expect(maskSecrets(`пароль: ${v}`).text).toBe(`пароль: ${SECRET_MASK}`);
    expect(maskSecrets(`Ключ = ${v}`).text).toBe(`Ключ = ${SECRET_MASK}`);
    expect(maskSecrets(`секрет — ${v}`).text).toBe(`секрет — ${SECRET_MASK}`);
  });

  it('длинная случайная строка без имени и без известного формата', () => {
    const r = maskSecrets(`вот ключ сервиса ${tok(40, 71)} пожалуйста`);
    expect(r.text).toBe(`вот ключ сервиса ${SECRET_MASK} пожалуйста`);
  });

  it('несколько ключей: count — все, names — без повторов, в порядке появления', () => {
    const r = maskSecrets(
      `A_KEY=${tok(20, 81)}\nB_TOKEN=${tok(20, 82)}\nA_KEY=${tok(20, 83)}\n${join('gh', 'p_', tok(36, 84))}`,
    );
    expect(r.count).toBe(4);
    expect(r.names).toEqual(['A_KEY', 'B_TOKEN']);
  });

  it('имя перед известным форматом тоже попадает в names', () => {
    const r = maskSecrets(`OPENAI=${join('sk-', 'proj-', tok(40, 91))}`);
    expect(r.text).toBe(`OPENAI=${SECRET_MASK}`);
    expect(r.names).toEqual(['OPENAI']);
  });
});

describe('maskSecrets: что не трогается', () => {
  const untouched = [
    'Поменяй цвет кнопки на зелёный и добавь футер',
    // chat_id владельца — не секрет: его передают правкой по совету ассистента.
    'владелец — chat_id 123456789',
    'OWNER_CHAT_ID=123456789',
    // Откат пишет sha в текст хода — шестнадцатеричное не скрывается.
    'Откат к 1fe2732a9c0d4e5b6f7081928374655647382910',
    'id заказа 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    // Заглушки и ссылки на переменные окружения — не значения.
    'API_KEY=${API_KEY}',
    'OPENAI_API_KEY=process.env.OPENAI_API_KEY',
    'SECRET_KEY=your_secret_key_here',
    'TOKEN=xxxxxxxxxxxx',
    'PASSWORD=********',
    'используй ключ из переменной WEATHER_API_KEY',
    // Обычные слова и идентификаторы кода.
    'AUTH_MODE=password_and_sms',
    'TOKEN_TYPE=SuperSecret',
    'переименуй ProductLifecycleServiceV2Test3Helper в Helper',
    'вызови useProductActionsHook2ForStudioPage3',
    'ключевые слова: доставка цветов, Москва',
    'ключ: красивыйДизайн2026',
    // Адреса без пароля, пути и публичные ключи.
    'AUTH_URL=https://example.com/oauth/authorize',
    'KEY_FILE=/etc/ssl/private/site.pem',
    'NEXT_PUBLIC_ANALYTICS_KEY=G-ABC123DEF4',
    'https://example.com/products/2026/flowers-and-gifts-catalogue-moscow',
    'время 12:30, телефон +7 900 000-00-00',
    'task-force-for-learning-pipeline-classification-models',
    'test_should_create_product_when_owner_has_free_month',
  ];

  it.each(untouched)('%s', (text) => {
    const r = maskSecrets(text);
    expect(r.text).toBe(text);
    expect(r.count).toBe(0);
    expect(r.names).toEqual([]);
  });

  it('идемпотентность: второй проход ничего не находит', () => {
    const once = maskSecrets(`A_KEY=${tok(20, 101)} и ${join('gh', 'p_', tok(36, 102))}`);
    const twice = maskSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
    expect(twice.names).toEqual([]);
  });

  it('пустой и не-строковый ввод не падает', () => {
    expect(maskSecrets('')).toEqual({ text: '', count: 0, names: [] });
    expect(maskSecrets(undefined as any)).toEqual({ text: '', count: 0, names: [] });
  });
});
