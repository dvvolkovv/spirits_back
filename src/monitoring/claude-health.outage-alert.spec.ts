import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { OPTIONAL_DEPS_METADATA } from '@nestjs/common/constants';
jest.mock('../common/telegram-alert', () => ({
  ...jest.requireActual('../common/telegram-alert'),
  sendTelegramPayload: jest.fn(async () => undefined),
}));
import { sendTelegramPayload } from '../common/telegram-alert';
import { ClaudeHealthService } from './claude-health.service';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { AnswerProvider, FallbackProvider } from '../common/services/llm-fallback';
import { CliSwitchState, cliOutageAffectedText, cliRecoveredText } from '../common/global-llm-messages';

/**
 * Алерт «Локальный Claude CLI недоступен» и его отбой знают об общем
 * рубильнике (ревью 01.11, R3; повторное ревью — I1, M4). Тексты по
 * состояниям проверяет global-llm-messages.spec.ts; здесь — что сервис берёт
 * их из cliOutageAffectedText/cliRecoveredText и правильно выводит состояние
 * модели рубильника из get() и fallbackStats(): enabled — ключ есть
 * (providers[x].enabled), down — она «не отвечает» (downUntil > now), и
 * тогда выбор рубильника её пропускает.
 */
describe('ClaudeHealthService — алерт о падении CLI и рубильник', () => {
  const ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.TELEGRAM_BOT_TOKEN = 'tg-test';
    process.env.TELEGRAM_CHAT_ID = 'chat-test';
    (sendTelegramPayload as jest.Mock).mockClear();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  type Prov = { enabled: boolean; downUntil: number };
  type Provs = Record<FallbackProvider, Prov>;
  const up: Prov = { enabled: true, downUntil: 0 };
  const noKey: Prov = { enabled: false, downUntil: 0 };
  /** «Не отвечает» ещё минуту — считается в момент теста, не при сборе таблицы. */
  const downNow = (): Prov => ({ enabled: true, downUntil: Date.now() + 60_000 });
  const healthyOnly = (provider: FallbackProvider): Provs => ({
    qwen: provider === 'qwen' ? up : noKey,
    kimi: provider === 'kimi' ? up : noKey,
  });

  /** Сервис с рубильником switchTo; alerted — инцидент уже открыт, personalClaude — результат SQL или его сбой. */
  const make = (
    switchTo: AnswerProvider,
    providers: Provs,
    alerted = false,
    personalClaude: boolean | Error = true,
  ): any => {
    let alertedState = alerted;
    const pg = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (/SELECT alerted/.test(sql)) return { rows: [{ alerted: alertedState }] };
        if (/INSERT INTO monitor_alert_state/.test(sql)) {
          alertedState = params?.[1] === true;
          return { rows: [] };
        }
        if (/ai_profiles_consolidated/.test(sql)) {
          if (personalClaude instanceof Error) throw personalClaude;
          return { rows: [{ present: personalClaude }] };
        }
        return { rows: [] };
      }),
    };
    const claudeCli = {
      text: jest.fn().mockResolvedValue('ok'),
      fallbackStats: jest.fn(() => ({ windowMs: 900_000, providers })),
    };
    const global = { get: jest.fn(async () => switchTo) };
    const svc = new ClaudeHealthService(pg as any, claudeCli as any, global as any);
    svc.newSwitchProbeCli = jest.fn(() => claudeCli);
    return svc;
  };
  const sent = (): string[] => (sendTelegramPayload as jest.Mock).mock.calls.map((c) => c[0].text);
  const setDown = (svc: any): void => {
    svc.cache.llmStatus = 'down';
    svc.cache.llmOutageKind = 'weekly_limit';
    svc.cache.llmError = 'лимит';
    svc.cliConsecutiveDown = 99;
  };

  const OUTAGE: Array<[string, AnswerProvider, () => Provs, CliSwitchState]> = [
    ['рубильник на Claude', 'claude', () => ({ qwen: up, kimi: up }), { switchProvider: 'claude', enabled: false, down: false }],
    ['Kimi без ключа', 'kimi', () => ({ qwen: up, kimi: noKey }), { switchProvider: 'kimi', enabled: false, down: false }],
    ['Qwen с ключом отвечает', 'qwen', () => ({ qwen: up, kimi: noKey }), { switchProvider: 'qwen', enabled: true, down: false }],
    ['Qwen с ключом «не отвечает»', 'qwen', () => ({ qwen: downNow(), kimi: noKey }), { switchProvider: 'qwen', enabled: true, down: true }],
  ];

  it.each(OUTAGE)('падение, %s — строка «Затронуто» из cliOutageAffectedText', async (_name, sw, providers, state) => {
    const svc = make(sw, providers());
    svc.cache.llmStatus = 'down';
    svc.cache.llmOutageKind = 'auth';
    svc.cache.llmError = 'не вошёл';
    // С запасом выше порога подряд-провалов (CLAUDE_OUTAGE_FAILS из окружения).
    svc.cliConsecutiveDown = 99;
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('<b>🔴 Локальный Claude CLI недоступен</b>');
    expect(sent()[0]).toContain(`\n${cliOutageAffectedText(state)} Чат-ассистенты (r.linkeon.io) — отдельный путь`);
  });

  const RECOVERY: Array<[string, AnswerProvider, () => Provs, CliSwitchState]> = [
    ['рубильник на Qwen, Qwen отвечает', 'qwen', () => ({ qwen: up, kimi: noKey }), { switchProvider: 'qwen', enabled: true, down: false }],
    ['рубильник на Qwen, Qwen «не отвечает»', 'qwen', () => ({ qwen: downNow(), kimi: noKey }), { switchProvider: 'qwen', enabled: true, down: true }],
    ['рубильник на Claude', 'claude', () => ({ qwen: up, kimi: up }), { switchProvider: 'claude', enabled: false, down: false }],
  ];

  it.each(RECOVERY)('отбой, %s — текст из cliRecoveredText', async (_name, sw, providers, state) => {
    const svc = make(sw, providers(), true);
    svc.cache.llmStatus = 'ok';
    svc.cache.llmCheckedAt = '2026-11-01T07:15:00.000Z';
    svc.cache.llmLatencyMs = 812;
    await svc.maybeAlertOutage();
    expect(sent()).toEqual([cliRecoveredText({ ...state, checkedAt: '2026-11-01T07:15:00.000Z', latencyMs: 812 })]);
  });

  it.each(['kimi', 'qwen'] as const)('живой глобальный %s без личного Claude — алерт и запись состояния подавлены', async (sw) => {
    const svc = make(sw, healthyOnly(sw), false, false);
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()).toEqual([]);
    expect(svc.pg.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO monitor_alert_state'),
      expect.anything(),
    );
    expect(svc.claudeCli.text).toHaveBeenCalledWith(
      'Reply with exactly: ok',
      expect.objectContaining({
        provider: sw,
        providerChoice: 'global',
        noFallback: true,
        model: 'claude-haiku-4-5',
        timeoutMs: 30_000,
        isolatedCwd: true,
        noSessionPersistence: true,
      }),
    );
    expect(svc.newSwitchProbeCli).toHaveBeenCalled();
  });

  it('живой глобальный Kimi и личный Claude — красный алерт сохраняется', async () => {
    const svc = make('kimi', healthyOnly('kimi'), false, true);
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('<b>🔴 Локальный Claude CLI недоступен</b>');
  });

  it.each([
    ['без ключа', () => noKey],
    ['«не отвечает»', downNow],
  ] as Array<[string, () => Prov]>)('глобальный Kimi %s — алерт сохраняется без SQL личных настроек', async (_name, kimiState) => {
    const svc = make('kimi', { qwen: noKey, kimi: kimiState() }, false, false);
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(svc.pg.query.mock.calls.some(([sql]) => /ai_profiles_consolidated/.test(sql))).toBe(false);
    expect(svc.claudeCli.text).not.toHaveBeenCalled();
  });

  it('сбой SQL личного Claude — fail-open, алерт сохраняется', async () => {
    const svc = make('kimi', healthyOnly('kimi'), false, new Error('db unavailable'));
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
  });

  it('открытый инцидент при наступившем подавлении — очищается молча на первом тикe после рестарта', async () => {
    const svc = make('kimi', healthyOnly('kimi'), true, false);
    setDown(svc);
    svc.cliConsecutiveDown = 1;
    svc.lastOutageAlertAt = new Date();
    await svc.maybeAlertOutage();
    expect(sent()).toEqual([]);
    expect(svc.claudeCli.text).toHaveBeenCalled();
    expect(svc.lastOutageAlertAt).toBeNull();
    expect(svc.pg.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO monitor_alert_state'),
      ['claude_cli', false],
    );
  });

  it('открытый инцидент при наступившем подавлении — отбой не отправляется, состояние очищается', async () => {
    const svc = make('kimi', healthyOnly('kimi'), true, false);
    svc.cache.llmStatus = 'ok';
    svc.lastOutageAlertAt = new Date();
    await svc.maybeAlertOutage();
    expect(sent()).toEqual([]);
    expect(svc.lastOutageAlertAt).toBeNull();
    expect(svc.pg.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO monitor_alert_state'),
      ['claude_cli', false],
    );
  });

  it('после молчаливой очистки возврат рубильника на Claude во время простоя даёт новый алерт', async () => {
    const svc = make('kimi', healthyOnly('kimi'), true, false);
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()).toEqual([]);
    expect(svc.pg.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO monitor_alert_state'),
      ['claude_cli', false],
    );
    (sendTelegramPayload as jest.Mock).mockClear();
    svc.globalProvider.get.mockResolvedValue('claude');
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('<b>🔴 Локальный Claude CLI недоступен</b>');
  });

  it('личный Claude при восстановлении — обычный отбой сохраняется', async () => {
    const svc = make('kimi', healthyOnly('kimi'), true, true);
    svc.cache.llmStatus = 'ok';
    svc.cache.llmCheckedAt = '2026-11-11T07:15:00.000Z';
    svc.cache.llmLatencyMs = 812;
    await svc.maybeAlertOutage();
    expect(sent()).toEqual([
      cliRecoveredText({
        switchProvider: 'kimi', enabled: true, down: false,
        checkedAt: '2026-11-11T07:15:00.000Z', latencyMs: 812,
      }),
    ]);
  });

  it.each(['error', 'empty', 'refusal'] as const)('активная Kimi-проба: %s — красный алерт и Kimi «не отвечает»', async (mode) => {
    const svc = make('kimi', healthyOnly('kimi'), true, false);
    if (mode === 'error') svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
    else svc.claudeCli.text.mockResolvedValue(mode === 'empty' ? '' : 'Not logged in · Please run /login');
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('контрольная проба Kimi не удалась');
    expect(sent()[0]).not.toContain('поэтому они идут обычным путём');
    expect(svc.pg.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO monitor_alert_state'),
      ['claude_cli', false],
    );
  });

  it('новый outage ниже порога без открытого инцидента — активной пробы нет', async () => {
    const svc = make('kimi', healthyOnly('kimi'), false, false);
    setDown(svc);
    svc.cliConsecutiveDown = 1;
    await svc.maybeAlertOutage();
    expect(sent()).toEqual([]);
    expect(svc.claudeCli.text).not.toHaveBeenCalled();
  });

  it('SQL личного Claude учитывает только активные аккаунты', async () => {
    const svc = make('kimi', healthyOnly('kimi'), false, false);
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(svc.pg.query).toHaveBeenCalledWith(expect.stringMatching(
      /ai_profiles_consolidated p[\s\S]*JOIN user_id u ON u.internal_id = p.user_id[\s\S]*u\.state = 'active'/,
    ));
  });

  it('после молчаливой очистки сбой активной пробы даёт новый алерт', async () => {
    const svc = make('kimi', healthyOnly('kimi'), true, false);
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()).toEqual([]);
    (sendTelegramPayload as jest.Mock).mockClear();
    svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('контрольная проба Kimi не удалась');
    expect(sent()[0]).not.toContain('поэтому они идут обычным путём');
  });

  it('проба использует новый CLI без PG и без shared состояния', () => {
    const svc = make('kimi', healthyOnly('kimi'), false, false);
    delete svc.newSwitchProbeCli;
    const first = svc.newSwitchProbeCli();
    const second = svc.newSwitchProbeCli();
    expect(first).not.toBe(svc.claudeCli);
    expect(first).not.toBe(second);
    expect(first.pg).toBeUndefined();
    expect(second.pg).toBeUndefined();
  });

  it('переключение рубильника во время пробы — fail-open без подавления', async () => {
    const svc = make('kimi', healthyOnly('kimi'), false, false);
    let resolveProbe!: (text: string) => void;
    svc.claudeCli.text.mockReturnValue(new Promise<string>((resolve) => { resolveProbe = resolve; }));
    setDown(svc);
    const pending = svc.maybeAlertOutage();
    await new Promise<void>((resolve) => setImmediate(resolve));
    svc.globalProvider.get.mockResolvedValue('claude');
    resolveProbe('ok');
    await pending;
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('проба без входа');
    expect(svc.claudeCli.text).toHaveBeenCalledTimes(1);
  });

  it('сбой активной пробы при новом инциденте — красный алерт и alerted=true', async () => {
    const svc = make('kimi', healthyOnly('kimi'), false, false);
    svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(svc.pg.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO monitor_alert_state'),
      ['claude_cli', true],
    );
  });

  it('сбой активной пробы при recovery — правдивый отбой без выдуманного fallback', async () => {
    const svc = make('kimi', healthyOnly('kimi'), true, false);
    svc.cache.llmStatus = 'ok';
    svc.cache.llmCheckedAt = '2026-11-11T07:15:00.000Z';
    svc.cache.llmLatencyMs = 812;
    svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('Claude снова отвечает');
    expect(sent()[0]).toContain('контрольная проба Kimi не удалась');
    expect(sent()[0]).not.toContain('Маша/VPM/маркетолог снова работают');
  });

  it('переключение рубильника во время SQL личного Claude — fail-open', async () => {
    const svc = make('kimi', healthyOnly('kimi'), false, false);
    let resolvePersonal!: () => void;
    const originalQuery = svc.pg.query.getMockImplementation()!;
    svc.pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/ai_profiles_consolidated/.test(sql)) {
        return new Promise((resolve) => {
          resolvePersonal = () => resolve({ rows: [{ present: false }] });
        });
      }
      return originalQuery(sql, params);
    });
    setDown(svc);
    const pending = svc.maybeAlertOutage();
    for (let i = 0; i < 5 && !resolvePersonal; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(resolvePersonal).toBeDefined();
    svc.globalProvider.get.mockResolvedValue('claude');
    resolvePersonal();
    await pending;
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('проба без входа');
  });

  it.each(['down', 'ok'] as const)('Kimi → Qwen во время пробы при %s — providerUnverified вместо healthy-текста', async (status) => {
    const svc = make('kimi', { qwen: up, kimi: up }, status === 'ok', false);
    if (status === 'down') setDown(svc);
    else {
      svc.cache.llmStatus = 'ok';
      svc.cache.llmCheckedAt = '2026-11-11T07:15:00.000Z';
      svc.cache.llmLatencyMs = 812;
    }
    let resolveProbe!: (text: string) => void;
    svc.claudeCli.text.mockReturnValue(new Promise<string>((resolve) => { resolveProbe = resolve; }));
    const pending = svc.maybeAlertOutage();
    await new Promise<void>((resolve) => setImmediate(resolve));
    svc.globalProvider.get.mockResolvedValue('qwen');
    resolveProbe('ok');
    await pending;
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('активная проба Qwen в этом тике не выполнялась');
    expect(sent()[0]).not.toContain('отвечают через эту модель');
    expect(sent()[0]).not.toContain('Маша/VPM/маркетолог снова работают');
    expect(svc.claudeCli.text).toHaveBeenCalledTimes(1);
  });

  it('fallbackAlertLine использует снимок после ожидания пробы', async () => {
    const svc = make('kimi', healthyOnly('kimi'), false, false);
    const initial = { windowMs: 900_000, providers: { qwen: noKey, kimi: up } };
    const fresh = {
      windowMs: 900_000,
      providers: { qwen: noKey, kimi: { enabled: true, ok: 2, failed: 1, downUntil: 0 } },
    };
    svc.claudeCli.fallbackStats.mockReturnValueOnce(initial).mockReturnValueOnce(fresh);
    svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
    setDown(svc);
    await svc.maybeAlertOutage();
    expect(sent()[0]).toContain('Kimi — ответов 2, ошибок 1');
  });
});

/**
 * Алерт не должен молча вернуться к прежнему тексту, если граф DI не нашёл
 * рубильник: зависимость объявлена КЛАССОМ (интерфейс стёрся бы в Object, и
 * Nest не нашёл бы провайдер по типу) и без @Optional() — поломка DI роняет
 * старт (поймает smoke), CommonModule глобальный. Тот же приём, что в
 * src/chat/llm-provider-di.spec.ts и admin-llm-provider.controller.spec.ts.
 */
describe('ClaudeHealthService: DI-тип рубильника', () => {
  it('конструктор объявляет GlobalLlmProviderService классом', () => {
    const types = Reflect.getMetadata('design:paramtypes', ClaudeHealthService);
    expect(Array.isArray(types)).toBe(true);
    expect(types).toContain(GlobalLlmProviderService);
  });

  it('GlobalLlmProviderService — без @Optional()', () => {
    const types: unknown[] = Reflect.getMetadata('design:paramtypes', ClaudeHealthService) ?? [];
    const idx = types.indexOf(GlobalLlmProviderService);
    const optional: number[] = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, ClaudeHealthService) ?? [];
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(optional).not.toContain(idx);
  });
});
