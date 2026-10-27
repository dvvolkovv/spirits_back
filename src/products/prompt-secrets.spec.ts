import { maskedSecretsSay, maskSecrets, SECRET_MASK } from './prompt-secrets';

/**
 * Значения ключей в этом файле СОБИРАЮТСЯ во время прогона, а не лежат
 * строками. Репозиторий публичный: готовая строка `ghp_…` или `sk-…` нужной
 * длины в исходнике — это находка для сканеров секретов GitHub (отказ пуша,
 * письма провайдерам), хотя ключ и выдуманный.
 */
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
function rnd(n: number, seed: number, alphabet: string): string {
  // Детерминированный разброс: тест должен падать одинаково на каждом прогоне.
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[(x >>> 8) % alphabet.length];
  }
  return out;
}
/** Случайная строка букв и цифр, с гарантированной смесью классов на конце. */
function tok(n: number, seed = 7, alphabet = ALNUM): string {
  return rnd(n - 3, seed, alphabet) + 'aZ7';
}
const join = (...parts: string[]) => parts.join('');
const unchanged = (text: string) => expect(maskSecrets(text)).toEqual({ text, count: 0, names: [] });

describe('maskSecrets: что скрывается', () => {
  it('строка «ИМЯ=значение»: значение скрыто, имя осталось и попало в names', () => {
    const r = maskSecrets(`Подключи погоду: WEATHER_API_KEY=${tok(32)} и покажи прогноз`);
    expect(r.text).toBe(`Подключи погоду: WEATHER_API_KEY=${SECRET_MASK} и покажи прогноз`);
    expect(r.count).toBe(1);
    expect(r.names).toEqual(['WEATHER_API_KEY']);
  });

  it('формы присваивания: двоеточие, кавычки, JSON, export, camelCase, CLI, markdown, таблица', () => {
    const v = tok(24, 11);
    for (const [line, name] of [
      [`API_TOKEN: ${v}`, 'API_TOKEN'],
      [`export DB_PASSWORD="${v}"`, 'DB_PASSWORD'],
      [`{"clientSecret": "${v}"}`, 'clientSecret'],
      [`apiKey = '${v}'`, 'apiKey'],
      [`x-api-key: ${v}`, 'x-api-key'],
      [`OpenAIKey=${v}`, 'OpenAIKey'],
      [`{"appid": "${v}"}`, 'appid'],
      [`node bot.js --password=${v}`, 'password'],
      [`run --api-key=${v}`, 'api-key'],
      [`**WEATHER_API_KEY**: ${v}`, 'WEATHER_API_KEY'],
      [`- **Token**: ${v}`, 'Token'],
      [`WEATHER_API_KEY — ${v}`, 'WEATHER_API_KEY'],
      [`| API_KEY | ${v} |`, 'API_KEY'],
    ] as const) {
      const r = maskSecrets(line);
      expect({ line, text: r.text }).toEqual({ line, text: line.replace(v, SECRET_MASK) });
      expect({ line, names: r.names }).toEqual({ line, names: [name] });
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
      join('AK', 'IA', rnd(16, 8, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
      join('AI', 'za', rnd(35, 9, ALNUM)),
      join('ya', '29.', tok(40, 10)),
      join('y0', '_', tok(40, 11)),
      join('AQ', 'VN', tok(36, 12)),
      join('hf', '_', tok(34, 13)),
      join('gs', 'k_', tok(40, 14)),
      join('SG.', tok(22, 15), '.', tok(43, 16)),
      join('live', '_', tok(40, 17)),
      join('sk', '_', rnd(48, 18, HEX)),
    ];
    for (const s of samples) {
      const r = maskSecrets(`ключ ${s} вставь в код`);
      expect({ s, text: r.text }).toEqual({ s, text: `ключ ${SECRET_MASK} вставь в код` });
      expect(r.count).toBe(1);
      expect(r.names).toEqual([]);
    }
  });

  it('шестнадцатеричные ключи: sk- + 32 hex и Bearer + 40 hex — на всех образцах', () => {
    // Ревью, I5: порог энтропии 3.5 пропускал каждый пятый такой ключ.
    for (let seed = 1; seed <= 300; seed++) {
      const ds = join('sk-', rnd(32, seed, HEX));
      expect(maskSecrets(`ключ ${ds}`).text).toBe(`ключ ${SECRET_MASK}`);
      const br = rnd(40, seed + 1000, HEX);
      expect(maskSecrets(`Authorization: Bearer ${br}`).text).toBe(`Authorization: Bearer ${SECRET_MASK}`);
    }
  });

  it('токен Telegram-бота — целиком, и в подписи «токен бота», и голым', () => {
    const t = join('7234567890', ':', 'AA', tok(33, 21));
    expect(maskSecrets(`токен бота ${t}`).text).toBe(`токен бота ${SECRET_MASK}`);
    expect(maskSecrets(`токен бота: ${t}`).text).toBe(`токен бота: ${SECRET_MASK}`);
  });

  it('JWT и заголовки Bearer, Basic, Token', () => {
    const jwt = join('ey', 'J', tok(20, 31), '.', 'ey', 'J', tok(30, 32), '.', tok(43, 33));
    expect(maskSecrets(`Authorization: Bearer ${jwt}`).text).toBe(`Authorization: Bearer ${SECRET_MASK}`);
    expect(maskSecrets(`заголовок Bearer ${tok(40, 34)}`).text).toBe(`заголовок Bearer ${SECRET_MASK}`);
    expect(maskSecrets(`вот токен ${jwt}`).text).toBe(`вот токен ${SECRET_MASK}`);
    const basic = Buffer.from(join('admin', ':', 'S3', 'cr3t', 'Pass')).toString('base64');
    expect(maskSecrets(`Authorization: Basic ${basic}`).text).toBe(`Authorization: Basic ${SECRET_MASK}`);
    const hex = rnd(40, 35, HEX);
    expect(maskSecrets(`Authorization: Token ${hex}`).text).toBe(`Authorization: Token ${SECRET_MASK}`);
  });

  it('пароль в адресе и в curl -u: скрыт только пароль', () => {
    const r = maskSecrets(`подключись к postgres://shop:${tok(16, 41)}@db.example.com:5432/shop`);
    expect(r.text).toBe(`подключись к postgres://shop:${SECRET_MASK}@db.example.com:5432/shop`);
    expect(r.names).toEqual([]);
    expect(maskSecrets(`curl -u admin:${tok(14, 42)} https://example.com`).text)
      .toBe(`curl -u admin:${SECRET_MASK} https://example.com`);
  });

  it('секреты в адресах: параметры с именем ключа, токен бота в Bot API, вебхуки', () => {
    const hex = rnd(32, 101, HEX);
    expect(maskSecrets(`https://api.openweathermap.org/data/2.5/weather?q=Moscow&appid=${hex}`).text)
      .toBe(`https://api.openweathermap.org/data/2.5/weather?q=Moscow&appid=${SECRET_MASK}`);
    const bot = join('7234567890', ':', 'AA', tok(33, 111));
    expect(maskSecrets(`шли в https://api.telegram.org/bot${bot}/sendMessage`).text)
      .toBe(`шли в https://api.telegram.org/bot${SECRET_MASK}/sendMessage`);
    const dis = tok(68, 112);
    expect(maskSecrets(`вебхук https://discord.com/api/webhooks/123456789012345678/${dis}`).text)
      .toBe(`вебхук https://discord.com/api/webhooks/123456789012345678/${SECRET_MASK}`);
    const sl = tok(24, 113);
    expect(maskSecrets(`https://hooks.slack.com/services/T0ABCDEF/B0ABCDEF/${sl}`).text)
      .toBe(`https://hooks.slack.com/services/T0ABCDEF/B0ABCDEF/${SECRET_MASK}`);
    const b24 = rnd(16, 114, 'abcdefghijklmnopqrstuvwxyz0123456789');
    expect(maskSecrets(`https://shop.bitrix24.ru/rest/1/${b24}/crm.lead.add`).text)
      .toBe(`https://shop.bitrix24.ru/rest/1/${SECRET_MASK}/crm.lead.add`);
  });

  it('закрытый ключ PEM — целиком, и обрезанный тоже', () => {
    const body = `${tok(64, 51)}\n${tok(64, 52)}\n${tok(20, 53)}==`;
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(maskSecrets(`ключ сервиса:\n${pem}\nспасибо`).text).toBe(`ключ сервиса:\n${SECRET_MASK}\nспасибо`);
    const cut = `-----BEGIN RSA PRIVATE KEY-----\n${body}`;
    expect(maskSecrets(`вот: ${cut}`).text).toBe(`вот: ${SECRET_MASK}`);
  });

  it('русские подписи: «пароль:», «Ключ =», «секрет —», со словами до разделителя и в markdown', () => {
    const v = join('Qw', '3rty', '!', tok(6, 61));
    expect(maskSecrets(`пароль: ${v}`).text).toBe(`пароль: ${SECRET_MASK}`);
    expect(maskSecrets(`Ключ = ${v}`).text).toBe(`Ключ = ${SECRET_MASK}`);
    expect(maskSecrets(`секрет — ${v}`).text).toBe(`секрет — ${SECRET_MASK}`);
    expect(maskSecrets(`пароль от админки: ${v}`).text).toBe(`пароль от админки: ${SECRET_MASK}`);
    expect(maskSecrets(`токен доступа: ${v}`).text).toBe(`токен доступа: ${SECRET_MASK}`);
    expect(maskSecrets(`Пароль от SMTP — ${v}`).text).toBe(`Пароль от SMTP — ${SECRET_MASK}`);
    expect(maskSecrets(`**Пароль:** ${v}`).text).toBe(`**Пароль:** ${SECRET_MASK}`);
    const hex = rnd(32, 62, HEX);
    expect(maskSecrets(`ключ от погоды: ${hex}`).text).toBe(`ключ от погоды: ${SECRET_MASK}`);
    expect(maskSecrets(`Ключ API: ${hex}`).text).toBe(`Ключ API: ${SECRET_MASK}`);
  });

  it('пароли: из одних букв, из цифр, со знаками, с пробелами пароля приложения', () => {
    const app16 = rnd(16, 71, 'abcdefghijklmnopqrstuvwxyz');
    expect(maskSecrets(`SMTP_PASSWORD=${app16}`).text).toBe(`SMTP_PASSWORD=${SECRET_MASK}`);
    expect(maskSecrets(`пароль: ${app16}`).text).toBe(`пароль: ${SECRET_MASK}`);
    const spaced = [0, 1, 2, 3].map((i) => rnd(4, 72 + i, 'abcdefghijklmnopqrstuvwxyz')).join(' ');
    expect(maskSecrets(`SMTP пароль: ${spaced}`).text).toBe(`SMTP пароль: ${SECRET_MASK}`);
    expect(maskSecrets('DB_PASSWORD=postgres').text).toBe(`DB_PASSWORD=${SECRET_MASK}`);
    expect(maskSecrets('пароль: 84629173').text).toBe(`пароль: ${SECRET_MASK}`);
    expect(maskSecrets('DB_PASSWORD=Xy7&kLm9#pQ2').text).toBe(`DB_PASSWORD=${SECRET_MASK}`);
    expect(maskSecrets('DB_PASSWORD=Pa(ss)w0rd!2026').text).toBe(`DB_PASSWORD=${SECRET_MASK}`);
    expect(maskSecrets('DB_PASSWORD=Abcdef12;tail_part9').text).toBe(`DB_PASSWORD=${SECRET_MASK}`);
  });

  it('длинная случайная строка без имени — только если рядом сказано, что это ключ', () => {
    const r = maskSecrets(`вот ключ сервиса ${tok(40, 81)} пожалуйста`);
    expect(r.text).toBe(`вот ключ сервиса ${SECRET_MASK} пожалуйста`);
  });

  it('несколько ключей: count — все, names — без повторов, в порядке появления', () => {
    const r = maskSecrets(
      `A_KEY=${tok(20, 91)}\nB_TOKEN=${tok(20, 92)}\nA_KEY=${tok(20, 93)}\n${join('gh', 'p_', tok(36, 94))}`,
    );
    expect(r.count).toBe(4);
    expect(r.names).toEqual(['A_KEY', 'B_TOKEN']);
  });

  it('имя перед известным форматом тоже попадает в names', () => {
    const r = maskSecrets(`OPENAI=${join('sk-', 'proj-', tok(40, 95))}`);
    expect(r.text).toBe(`OPENAI=${SECRET_MASK}`);
    expect(r.names).toEqual(['OPENAI']);
  });

  it('маска, уже бывшая во вводе (скопировали из истории), второй раз не докладывается', () => {
    const r = maskSecrets(`A_KEY=${SECRET_MASK} и B_TOKEN=${tok(20, 96)}`);
    expect(r.count).toBe(1);
    expect(r.names).toEqual(['B_TOKEN']);
  });

  it('ключ под подписью «ключ:» в форме NAME=… — одна маска и имя (ревью, I4)', () => {
    const r = maskSecrets(`ключ: WEATHER_API_KEY=${tok(24, 97)}`);
    expect(r.text).toBe(`ключ: WEATHER_API_KEY=${SECRET_MASK}`);
    expect(r).toMatchObject({ count: 1, names: ['WEATHER_API_KEY'] });
  });

  it('настоящий случай с прода (25.10): ключи Ozon скрыты, числовой Client ID остался', () => {
    const uuid = [8, 4, 4, 4, 12].map((n, i) => rnd(n, 120 + i, HEX)).join('-');
    const text = `Ключи:\nOZON_CLIENT_ID = 324542\nOZON_API_KEY = ${uuid}\nOZON_PERF_CLIENT_SECRET = ${tok(40, 126)}`;
    const r = maskSecrets(text);
    expect(r.text).toBe(`Ключи:\nOZON_CLIENT_ID = 324542\nOZON_API_KEY = ${SECRET_MASK}\nOZON_PERF_CLIENT_SECRET = ${SECRET_MASK}`);
    expect(r.names).toEqual(['OZON_API_KEY', 'OZON_PERF_CLIENT_SECRET']);
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
    // Ссылки на значения в коде (ревью, I2).
    'const apiKey = this.config.apiKey;',
    'const token = env.TELEGRAM_BOT_TOKEN;',
    'API_KEY = settings.WEATHER_API_KEY',
    'token := os.Getenv("BOT_TOKEN")',
    'password = os.getenv("DB_PASSWORD")',
    'const key = Deno.env.get("WEATHER_KEY")',
    'String token = System.getenv("BOT_TOKEN");',
    'const t = ctx.secrets.BOT_TOKEN',
    'const token = localStorage.getItem("jwt_access_token")',
    'AUTH_EMAIL=noreply@shop.ru',
    // Слово-признак внутри обычного слова (ревью, I3).
    'author: Ivan_Petrov',
    '"author": "D.Volkov"',
    'passenger_name: Ivan_Ivanov',
    'Passport: AB1234567',
    'secretary_email: anna.petrova@mail.ru',
    'hotkey: Ctrl+Shift+K',
    'keycloak_realm: shop-prod-2',
    'tokenizer: "bert-base-uncased-v2"',
    'Keynote: Dr.Smith',
    'AUTH_MODE=password_and_sms',
    'TOKEN_TYPE=SuperSecret',
    'Password: Enter your password',
    // Обычные слова и идентификаторы кода.
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
    'test_user_2_with_id_12345_and_flag_A',
    'Ошибка 50001:connection_reset_by_peer_while_reading_body',
  ];

  it.each(untouched)('%s', (text) => unchanged(text));

  // Найдено на правках прода 27.10 и в ревью: ID документов и параметры в
  // ссылках, голые ID в тексте выглядят как ключи; вставленная картинка — тоже.
  it('ссылки: таблицы, файлы, фото, плейлисты, Dropbox, Apps Script — не трогаются', () => {
    const id = join('1Bxi', tok(40, 121));
    for (const text of [
      `данные бери из https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
      `таблица docs.google.com/spreadsheets/d/${id}`,
      `файл [прайс](https://drive.google.com/file/d/${id}/view)`,
      `картинка https://drive.google.com/uc?export=view&id=${id}`,
      `фон https://images.unsplash.com/photo-1500000000000-${rnd(12, 122, HEX)}?ixid=${tok(40, 123)}%3D%3D&w=1200`,
      `https://www.dropbox.com/scl/fi/${tok(24, 124)}/price.pdf?rlkey=${tok(25, 125)}&dl=0`,
      `https://www.youtube.com/playlist?list=PL${tok(32, 126)}&fbclid=${tok(40, 127)}`,
      `https://script.google.com/macros/s/AKfycb${tok(60, 128)}/exec`,
      `ID таблицы ${id}`,
    ]) {
      unchanged(text);
    }
  });

  it('публичное: кошельки, reCAPTCHA, SRI, publishable-ключи — не трогаются (ревью, I1, I4)', () => {
    for (const text of [
      `мой кошелёк TON: UQ${rnd(46, 131, ALNUM + '_-')}`,
      `адрес USDT TRC20: T${rnd(33, 132, '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')}`,
      `ETH 0x${rnd(40, 133, '0123456789abcdefABCDEF')}`,
      `<div class="g-recaptcha" data-sitekey="6Le${rnd(37, 134, ALNUM)}"></div>`,
      `<script src="/lib.js" integrity="sha384-${tok(40, 135)}/${tok(20, 136)}" crossorigin="anonymous"></script>`,
      `STRIPE_PUBLISHABLE_KEY=pk_live_${tok(40, 137)}`,
      `NEXT_PUBLIC_MAPBOX_TOKEN=pk.ey${join('J', tok(30, 138), '.', tok(22, 139))}`,
    ]) {
      unchanged(text);
    }
  });

  it('base64-картинка — ни в data:-адресе, ни голым блобом — не режется', () => {
    const blob = Array.from({ length: 8 }, (_, i) => tok(60, 140 + i)).join('/') + '+' + tok(40, 150) + '==';
    for (const text of [`иконка data:image/png;base64,${blob}`, `вставь картинку BEGIN /9j/${blob}`]) {
      unchanged(text);
    }
  });

  it('идемпотентность: второй проход ничего не находит', () => {
    const once = maskSecrets(`A_KEY=${tok(20, 161)} и ${join('gh', 'p_', tok(36, 162))}`);
    expect(maskSecrets(once.text)).toEqual({ text: once.text, count: 0, names: [] });
  });

  it('идемпотентность на случайных смесях подписей, имён и значений (ревью, Minor 1)', () => {
    const pieces = ['пароль', ' = ', ': ', 'API_KEY', 'ghp_', 'ключ', ' — ', '=', 'xHc1', SECRET_MASK, ' ', '\n',
      'Bearer ', 'https://x.ru/?token=', '**', 'sk-', '"', 'eyJ', '.'];
    for (let seed = 1; seed <= 3000; seed++) {
      let x = seed;
      let s = '';
      for (let i = 0; i < 12; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        s += pieces[(x >>> 8) % pieces.length];
        if ((x >>> 4) % 3 === 0) s += tok(20 + ((x >>> 12) % 24), x);
      }
      const once = maskSecrets(s);
      expect({ s, again: maskSecrets(once.text).count }).toEqual({ s, again: 0 });
    }
  });

  it('пустой и не-строковый ввод не падает; NUL не ломает разбор', () => {
    expect(maskSecrets('')).toEqual({ text: '', count: 0, names: [] });
    expect(maskSecrets(undefined as any)).toEqual({ text: '', count: 0, names: [] });
    expect(maskSecrets('a\u00000\u0000b').text).toBe('a�0�b');
  });
});

/**
 * Ревью, C1: регулярка пароля в адресе с `\b` и схемой без потолка давала
 * квадратичный перебор — 160 КБ «a.a.a.…» держали API 12 с. Текст приходит от
 * клиента, API живёт одним процессом. Каждый злой ввод — 200 КБ.
 */
describe('maskSecrets: время линейное', () => {
  const N = 200_000;
  const evil = [
    'a.'.repeat(N / 2),
    'ab-'.repeat(N / 3),
    'a+'.repeat(N / 2),
    'a'.repeat(N),
    'A1'.repeat(N / 2),
    'key='.repeat(N / 4),
    'пароль: '.repeat(N / 8),
    'https://'.repeat(N / 8),
    'eyJ'.repeat(N / 3),
    '-----BEGIN PRIVATE KEY-----'.repeat(N / 27),
    'x.'.repeat(N / 4) + 'com/' + 'a'.repeat(N / 2),
    ('ключ от ' + 'а'.repeat(20) + ' ').repeat(N / 29),
  ];

  it.each(evil.map((s, i) => [i, s] as const))('злой ввод №%d — быстрее 300 мс', (_i, s) => {
    const t0 = Date.now();
    maskSecrets(s);
    expect(Date.now() - t0).toBeLessThan(300);
  });
});

describe('maskedSecretsSay', () => {
  it('условная: и про ключ, и про ложное срабатывание; имена названы', () => {
    const say = maskedSecretsSay({ count: 2, names: ['A_KEY', 'B_TOKEN'] });
    expect(say).toContain('(A_KEY, B_TOKEN)');
    expect(say).toContain(`«${SECRET_MASK}»`);
    expect(say).toMatch(/Если это ключ — посоветуй выпустить новый/);
    expect(say).toMatch(/Если скрыто не ключ/);
  });

  it('отказ (правка не поставлена) — без обещания, что значение заменено', () => {
    const say = maskedSecretsSay({ count: 1, names: [] }, { stored: false });
    expect(say).toMatch(/правка не поставлена/);
    expect(say).not.toContain('заменила');
  });
});
