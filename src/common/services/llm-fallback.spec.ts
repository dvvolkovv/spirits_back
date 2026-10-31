import {
  DEFAULT_BREAKER_MS,
  FALLBACK_ORDER,
  FallbackConfig,
  FallbackProvider,
  FallbackState,
  PROVIDER_DEFAULTS,
  STATS_WINDOW_MS,
  fallbackModelFor,
  fallbackSpawnEnv,
  fallbackTimeoutMs,
  isAnswerProvider,
  isFallbackWorthy,
  planProviders,
  readBreakerMs,
  readFallbackConfig,
  readFallbackConfigs,
} from './llm-fallback';

const QWEN_MODELS = { opus: 'qwen3.8-max', sonnet: 'qwen3.8-flash', haiku: 'qwen3.6-flash' };
const KIMI_MODELS = { opus: 'k3.1-pro', sonnet: 'k3.1-pro', haiku: 'k3.1-pro' };

describe('readFallbackConfig', () => {
  it('без ключа — null (провайдер выключен)', () => {
    expect(readFallbackConfig('qwen', {})).toBeNull();
    expect(readFallbackConfig('kimi', { KIMI_FALLBACK_API_KEY: '   ' })).toBeNull();
  });

  it('Qwen с ключом — значения по умолчанию, ключ без пробелов', () => {
    expect(readFallbackConfig('qwen', { QWEN_FALLBACK_API_KEY: ' sk-sp-x ' })).toEqual({
      name: 'qwen', apiKey: 'sk-sp-x', baseUrl: PROVIDER_DEFAULTS.qwen.baseUrl, models: QWEN_MODELS,
    });
  });

  it('Kimi с ключом — адрес Kimi Code и k3.1-pro для всех классов', () => {
    expect(readFallbackConfig('kimi', { KIMI_FALLBACK_API_KEY: 'sk-kimi-x' })).toEqual({
      name: 'kimi', apiKey: 'sk-kimi-x', baseUrl: 'https://api.kimi.ai/coding', models: KIMI_MODELS,
    });
  });

  it('переопределения из env — у каждого провайдера свои', () => {
    const env = {
      QWEN_FALLBACK_API_KEY: 'q',
      KIMI_FALLBACK_API_KEY: 'k',
      KIMI_FALLBACK_BASE_URL: 'https://x.example/coding',
      KIMI_FALLBACK_MODEL_OPUS: 'k3',
      KIMI_FALLBACK_MODEL_SONNET: 'k3-256k',
      KIMI_FALLBACK_MODEL_HAIKU: 'k3.1-pro-highspeed',
    };
    expect(readFallbackConfig('kimi', env)).toEqual({
      name: 'kimi', apiKey: 'k', baseUrl: 'https://x.example/coding',
      models: { opus: 'k3', sonnet: 'k3-256k', haiku: 'k3.1-pro-highspeed' },
    });
    // Переменные Kimi Qwen не задевают.
    expect(readFallbackConfig('qwen', env)!.models).toEqual(QWEN_MODELS);
  });

  it('readFallbackConfigs — по всем запасным, порядок цепочки Qwen → Kimi', () => {
    expect(FALLBACK_ORDER).toEqual(['qwen', 'kimi']);
    const all = readFallbackConfigs({ KIMI_FALLBACK_API_KEY: 'k' });
    expect(all.qwen).toBeNull();
    expect(all.kimi?.name).toBe('kimi');
  });
});

describe('readBreakerMs', () => {
  it('по умолчанию — 5 минут', () => expect(readBreakerMs({})).toBe(DEFAULT_BREAKER_MS));
  it('новое имя', () => expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: '60000' })).toBe(60000));
  it('прежнее имя — если нового нет', () => expect(readBreakerMs({ QWEN_FALLBACK_BREAKER_MS: '30000' })).toBe(30000));
  it('новое побеждает прежнее', () => {
    expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: '1000', QWEN_FALLBACK_BREAKER_MS: '2000' })).toBe(1000);
  });
  it('кривое — по умолчанию; 0 — допустимо', () => {
    expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: 'abc' })).toBe(DEFAULT_BREAKER_MS);
    expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: '-5' })).toBe(DEFAULT_BREAKER_MS);
    expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: '0' })).toBe(0);
  });
});

describe('fallbackModelFor', () => {
  it.each([
    ['claude-opus-5-5', 'qwen3.8-max'],
    ['opus', 'qwen3.8-max'],
    ['default', 'qwen3.8-max'],
    ['что-то незнакомое', 'qwen3.8-max'],
    ['sonnet', 'qwen3.8-flash'],
    ['claude-sonnet-5', 'qwen3.8-flash'],
    ['haiku', 'qwen3.6-flash'],
    ['claude-haiku-4-5', 'qwen3.6-flash'],
    ['Claude-Haiku-4-5-20251001', 'qwen3.6-flash'],
  ])('Qwen: %s → %s', (requested, expected) => {
    expect(fallbackModelFor(requested, QWEN_MODELS)).toBe(expected);
  });

  it('Kimi: любой класс — k3.1-pro', () => {
    for (const m of ['claude-opus-5-5', 'sonnet', 'claude-haiku-4-5', 'default']) {
      expect(fallbackModelFor(m, KIMI_MODELS)).toBe('k3.1-pro');
    }
  });
});

describe('isFallbackWorthy', () => {
  it.each([
    'claude CLI exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed',
    'claude CLI exited with code 1: Not logged in · Please run /login',
    "claude CLI error: You've hit your weekly limit · resets Nov 3",
    'claude CLI error: API Error: 429 rate limit',
    'claude CLI error: API Error: 529 Overloaded',
    'claude CLI exited with code 1: Failed to authenticate. API Error: 401 Invalid Authentication',
    'claude CLI error: API Error: 403 {"code":"AccessDenied.Unpurchased","message":"Access denied"}',
    'claude CLI error: API Error: 403 Forbidden',
    'claude CLI error: API Error: 400 Arrearage: your account is overdue',
  ])('переключаемся: %s', (msg) => {
    expect(isFallbackWorthy(msg)).toBe(true);
  });

  it.each([
    'claude CLI timeout after 60000ms',
    'claude CLI returned invalid JSON: Unexpected token n in JSON at position 0',
    'claude CLI spawn error: ENOENT',
  ])('не переключаемся: %s', (msg) => {
    expect(isFallbackWorthy(msg)).toBe(false);
  });

  it.each([
    'claude CLI error: Context limit reached · /compact or /clear to continue',
    'claude CLI error: Prompt is too long: 250000 tokens',
    'claude CLI error: max_tokens exceeded',
    'claude CLI error: response exceeded the 32000 output token maximum',
  ])('длина контекста — не переключаемся: %s', (msg) => {
    expect(isFallbackWorthy(msg)).toBe(false);
  });
});

describe('fallbackSpawnEnv', () => {
  const kimi = readFallbackConfig('kimi', { KIMI_FALLBACK_API_KEY: 'sk-kimi-x' })!;
  const qwen = readFallbackConfig('qwen', { QWEN_FALLBACK_API_KEY: 'sk-sp-x' })!;

  it('снимает чужие ANTHROPIC_* и OAuth-токен, ставит адрес, ключ и модели провайдера, один повтор', () => {
    const env = fallbackSpawnEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'old',
      ANTHROPIC_MODEL: 'claude-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    }, kimi);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding',
      ANTHROPIC_AUTH_TOKEN: 'sk-kimi-x',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'k3.1-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'k3.1-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'k3.1-pro',
      CLAUDE_CODE_SUBAGENT_MODEL: 'k3.1-pro',
      CLAUDE_CODE_MAX_RETRIES: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('у Qwen — его адрес и модели', () => {
    const env = fallbackSpawnEnv({}, qwen);
    expect(env.ANTHROPIC_BASE_URL).toBe(PROVIDER_DEFAULTS.qwen.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-x');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3.6-flash');
  });

  it('таймаут одного запроса к API — 300 с, в том числе поверх своего в base', () => {
    expect(fallbackSpawnEnv({}, kimi).API_TIMEOUT_MS).toBe('300000');
    expect(fallbackSpawnEnv({ API_TIMEOUT_MS: '3000000' }, kimi).API_TIMEOUT_MS).toBe('300000');
  });

  it('не меняет переданный объект', () => {
    const base = { ANTHROPIC_API_KEY: 'old' };
    fallbackSpawnEnv(base, kimi);
    expect(base).toEqual({ ANTHROPIC_API_KEY: 'old' });
  });

  // SCRUB=1 на Linux требует bubblewrap: без него CLI падает сразу (30.10 —
  // прод и релей без bwrap). Явный '0' — поверх унаследованного '1'.
  it('вычистка окружения подпроцессов выключена явно', () => {
    expect(fallbackSpawnEnv({}, kimi).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
    expect(fallbackSpawnEnv({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, kimi).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
  });
});

describe('fallbackTimeoutMs', () => {
  it('остаток бюджета после упавших попыток, если он больше минуты', () => {
    expect(fallbackTimeoutMs(100_000, 30_000)).toBe(70_000);
  });
  it('не меньше минуты — даже когда прежние попытки съели весь бюджет', () => {
    expect(fallbackTimeoutMs(100_000, 99_000)).toBe(60_000);
    expect(fallbackTimeoutMs(100_000, 150_000)).toBe(60_000);
  });
  it('бюджет меньше минуты — весь бюджет', () => {
    expect(fallbackTimeoutMs(30_000, 29_000)).toBe(30_000);
  });
  it('0 — без таймаута, и у следующей попытки тоже', () => {
    expect(fallbackTimeoutMs(0, 12_345)).toBe(0);
  });
});

describe('isAnswerProvider', () => {
  it.each(['claude', 'qwen', 'kimi'])('%s — да', (v) => expect(isAnswerProvider(v)).toBe(true));
  it.each(['gpt', '', 'Qwen', null, undefined, 1])('%p — нет', (v) => expect(isAnswerProvider(v)).toBe(false));
});

describe('FallbackState', () => {
  it('окно Claude: открытие, истечение, закрытие успехом, начатым после открытия', () => {
    const s = new FallbackState();
    expect(s.claudeWindowOpen(1000)).toBe(false);
    s.openClaudeWindow(60_000, 1000);
    expect(s.claudeWindowOpen(2000)).toBe(true);
    expect(s.claudeWindowUntil(2000)).toBe(61_000);
    s.claudeSucceeded(500); // начат до открытия — окно не закрывает
    expect(s.claudeWindowOpen(2000)).toBe(true);
    s.claudeSucceeded(1500); // начат после — закрывает
    expect(s.claudeWindowOpen(2000)).toBe(false);
    expect(s.claudeWindowUntil(2000)).toBe(0);
    s.openClaudeWindow(60_000, 3000);
    expect(s.claudeWindowUntil(70_000)).toBe(0); // истекло — 0, а не момент в прошлом
    s.openClaudeWindow(60_000, 80_000);
    s.closeClaudeWindow();
    expect(s.claudeWindowOpen(80_001)).toBe(false);
  });

  it('«не отвечает» — своё у каждого запасного', () => {
    const s = new FallbackState();
    s.markDown('qwen', 60_000, 1000);
    expect(s.isDown('qwen', 2000)).toBe(true);
    expect(s.isDown('kimi', 2000)).toBe(false);
    expect(s.downUntilOf('qwen', 2000)).toBe(61_000);
    expect(s.downUntilOf('qwen', 61_000)).toBe(0);
    s.markUp('qwen');
    expect(s.isDown('qwen', 2000)).toBe(false);
  });

  it('исходы — по провайдеру, за 15 минут', () => {
    const s = new FallbackState();
    s.recordOutcome('qwen', true, 1000);
    s.recordOutcome('qwen', false, 2000);
    s.recordOutcome('kimi', true, 3000);
    expect(s.counts('qwen', 4000)).toEqual({ ok: 1, failed: 1 });
    expect(s.counts('kimi', 4000)).toEqual({ ok: 1, failed: 0 });
    expect(s.counts('qwen', 2000 + STATS_WINDOW_MS + 1)).toEqual({ ok: 0, failed: 0 });
  });
});

describe('planProviders', () => {
  const cfg = (name: 'qwen' | 'kimi'): FallbackConfig => ({ name, apiKey: 'k', baseUrl: 'u', models: { opus: 'o', sonnet: 's', haiku: 'h' } });
  const both = { qwen: cfg('qwen'), kimi: cfg('kimi') };
  const T = 10_000;

  it('noFallback — только Claude, выбор не действует', () => {
    expect(planProviders({ selected: 'kimi', configs: both, state: new FallbackState(), noFallback: true, now: T })).toEqual(['claude']);
  });
  it('окно Claude закрыто — Claude, Qwen, Kimi', () => {
    expect(planProviders({ configs: both, state: new FallbackState(), now: T })).toEqual(['claude', 'qwen', 'kimi']);
  });
  it('без ключа Qwen — Claude, Kimi', () => {
    expect(planProviders({ configs: { qwen: null, kimi: cfg('kimi') }, state: new FallbackState(), now: T })).toEqual(['claude', 'kimi']);
  });
  it('без ключей — только Claude', () => {
    expect(planProviders({ configs: { qwen: null, kimi: null }, state: new FallbackState(), now: T })).toEqual(['claude']);
  });
  it('окно Claude открыто — только запасные', () => {
    const s = new FallbackState();
    s.openClaudeWindow(60_000, T);
    expect(planProviders({ configs: both, state: s, now: T + 1 })).toEqual(['qwen', 'kimi']);
  });
  it('запасной «не отвечает» — пропускается', () => {
    const s = new FallbackState();
    s.markDown('qwen', 60_000, T);
    expect(planProviders({ configs: both, state: s, now: T + 1 })).toEqual(['claude', 'kimi']);
  });
  it('окно открыто, а все запасные «не отвечают» — Claude', () => {
    const s = new FallbackState();
    s.openClaudeWindow(60_000, T);
    s.markDown('qwen', 60_000, T);
    s.markDown('kimi', 60_000, T);
    expect(planProviders({ configs: both, state: s, now: T + 1 })).toEqual(['claude']);
  });
  it('выбран Kimi — сначала он, затем обычный путь без него', () => {
    expect(planProviders({ selected: 'kimi', configs: both, state: new FallbackState(), now: T })).toEqual(['kimi', 'claude', 'qwen']);
  });
  it('выбран Kimi при открытом окне — Kimi, затем Qwen', () => {
    const s = new FallbackState();
    s.openClaudeWindow(60_000, T);
    expect(planProviders({ selected: 'kimi', configs: both, state: s, now: T + 1 })).toEqual(['kimi', 'qwen']);
  });
  it('выбранный пробуется первым, даже когда он «не отвечает»', () => {
    const s = new FallbackState();
    s.markDown('kimi', 60_000, T);
    expect(planProviders({ selected: 'kimi', configs: both, state: s, now: T + 1 })).toEqual(['kimi', 'claude', 'qwen']);
  });
  it('выбран без ключа — обычный путь', () => {
    expect(planProviders({ selected: 'kimi', configs: { qwen: cfg('qwen'), kimi: null }, state: new FallbackState(), now: T })).toEqual(['claude', 'qwen']);
  });
  it('незнакомый выбор (из БД пришло не то) — обычный путь', () => {
    expect(planProviders({ selected: 'gpt' as FallbackProvider, configs: both, state: new FallbackState(), now: T })).toEqual(['claude', 'qwen', 'kimi']);
  });
  it('выбор — имя из прототипа объекта (constructor) — обычный путь', () => {
    expect(planProviders({ selected: 'constructor' as FallbackProvider, configs: both, state: new FallbackState(), now: T })).toEqual(['claude', 'qwen', 'kimi']);
  });
  it('выбран Kimi, окно Claude открыто, Qwen «не отвечает» — Kimi, затем Claude', () => {
    const s = new FallbackState();
    s.openClaudeWindow(60_000, T);
    s.markDown('qwen', 60_000, T);
    expect(planProviders({ selected: 'kimi', configs: both, state: s, now: T + 1 })).toEqual(['kimi', 'claude']);
  });
});
