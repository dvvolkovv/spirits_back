import {
  QWEN_DEFAULT_BASE_URL,
  QWEN_DEFAULT_BREAKER_MS,
  fallbackTimeoutMs,
  isFallbackWorthy,
  qwenModelFor,
  qwenSpawnEnv,
  readQwenFallbackConfig,
} from './qwen-fallback';

const MODELS = { opus: 'qwen3.8-max', sonnet: 'qwen3.8-flash', haiku: 'qwen3.6-flash' };

describe('readQwenFallbackConfig', () => {
  it('без ключа — null (запасного пути нет)', () => {
    expect(readQwenFallbackConfig({})).toBeNull();
    expect(readQwenFallbackConfig({ QWEN_FALLBACK_API_KEY: '   ' })).toBeNull();
  });

  it('с ключом — значения по умолчанию, ключ без пробелов', () => {
    expect(readQwenFallbackConfig({ QWEN_FALLBACK_API_KEY: ' sk-sp-x ' })).toEqual({
      apiKey: 'sk-sp-x',
      baseUrl: QWEN_DEFAULT_BASE_URL,
      models: MODELS,
      breakerMs: QWEN_DEFAULT_BREAKER_MS,
    });
  });

  it('переопределения из env', () => {
    expect(readQwenFallbackConfig({
      QWEN_FALLBACK_API_KEY: 'k',
      QWEN_FALLBACK_BASE_URL: 'https://x.example/apps/anthropic',
      QWEN_FALLBACK_MODEL_OPUS: 'm-opus',
      QWEN_FALLBACK_MODEL_SONNET: 'm-sonnet',
      QWEN_FALLBACK_MODEL_HAIKU: 'm-haiku',
      QWEN_FALLBACK_BREAKER_MS: '60000',
    })).toEqual({
      apiKey: 'k',
      baseUrl: 'https://x.example/apps/anthropic',
      models: { opus: 'm-opus', sonnet: 'm-sonnet', haiku: 'm-haiku' },
      breakerMs: 60000,
    });
  });

  it('кривое окно предохранителя — по умолчанию; 0 — допустимо', () => {
    const base = { QWEN_FALLBACK_API_KEY: 'k' };
    expect(readQwenFallbackConfig({ ...base, QWEN_FALLBACK_BREAKER_MS: 'abc' })!.breakerMs).toBe(QWEN_DEFAULT_BREAKER_MS);
    expect(readQwenFallbackConfig({ ...base, QWEN_FALLBACK_BREAKER_MS: '-5' })!.breakerMs).toBe(QWEN_DEFAULT_BREAKER_MS);
    expect(readQwenFallbackConfig({ ...base, QWEN_FALLBACK_BREAKER_MS: '' })!.breakerMs).toBe(QWEN_DEFAULT_BREAKER_MS);
    expect(readQwenFallbackConfig({ ...base, QWEN_FALLBACK_BREAKER_MS: '0' })!.breakerMs).toBe(0);
  });
});

describe('qwenModelFor', () => {
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
  ])('%s → %s', (requested, expected) => {
    expect(qwenModelFor(requested, MODELS)).toBe(expected);
  });
});

describe('isFallbackWorthy', () => {
  it.each([
    'claude CLI exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed',
    'claude CLI exited with code 1: Not logged in · Please run /login',
    "claude CLI error: You've hit your weekly limit · resets Nov 3",
    'claude CLI error: API Error: 429 rate limit',
    'claude CLI error: API Error: 529 Overloaded',
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

  // Ошибки длины контекста — свойство самого запроса, а не доступа к Claude:
  // Qwen их не исправит, а окно открылось бы для всех.
  it.each([
    'claude CLI error: Context limit reached · /compact or /clear to continue',
    'claude CLI error: Prompt is too long: 250000 tokens',
    'claude CLI error: max_tokens exceeded',
    'claude CLI error: Context window exceeded · try again with a shorter prompt',
    'claude CLI error: API Error: 400 input length and `max_tokens` exceed context limit: 195000 + 21333 > 200000',
    'claude CLI error: response exceeded the 32000 output token maximum',
  ])('длина контекста — не переключаемся: %s', (msg) => {
    expect(isFallbackWorthy(msg)).toBe(false);
  });
});

describe('qwenSpawnEnv', () => {
  const cfg = readQwenFallbackConfig({ QWEN_FALLBACK_API_KEY: 'sk-sp-x' })!;

  it('снимает чужие ANTHROPIC_* и OAuth-токен, ставит адрес, ключ, модели, один повтор', () => {
    const env = qwenSpawnEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'old',
      ANTHROPIC_MODEL: 'claude-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    }, cfg);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: QWEN_DEFAULT_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: 'sk-sp-x',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-max',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.8-max',
      CLAUDE_CODE_MAX_RETRIES: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('таймаут одного запроса к API — 300 с, в том числе поверх своего в base', () => {
    expect(qwenSpawnEnv({}, cfg).API_TIMEOUT_MS).toBe('300000');
    expect(qwenSpawnEnv({ API_TIMEOUT_MS: '3000000' }, cfg).API_TIMEOUT_MS).toBe('300000');
  });

  it('не меняет переданный объект', () => {
    const base = { ANTHROPIC_API_KEY: 'old' };
    qwenSpawnEnv(base, cfg);
    expect(base).toEqual({ ANTHROPIC_API_KEY: 'old' });
  });

  // SCRUB=1 на Linux требует bubblewrap: без него CLI падает сразу (30.10 —
  // прод и релей без bwrap). Явный '0' — поверх унаследованного '1'.
  it('вычистка окружения подпроцессов выключена явно (SCRUB=1 без bwrap роняет CLI)', () => {
    expect(qwenSpawnEnv({}, cfg).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
    expect(qwenSpawnEnv({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, cfg).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
  });
});

describe('fallbackTimeoutMs', () => {
  it('остаток бюджета после попытки Claude, если он больше минуты', () => {
    expect(fallbackTimeoutMs(100_000, 30_000)).toBe(70_000);
  });

  it('не меньше минуты — даже когда попытка Claude съела весь бюджет', () => {
    expect(fallbackTimeoutMs(100_000, 99_000)).toBe(60_000);
    expect(fallbackTimeoutMs(100_000, 150_000)).toBe(60_000);
  });

  it('бюджет меньше минуты — весь бюджет', () => {
    expect(fallbackTimeoutMs(30_000, 29_000)).toBe(30_000);
  });

  it('0 — без таймаута, и у запасного вызова тоже', () => {
    expect(fallbackTimeoutMs(0, 12_345)).toBe(0);
  });
});
