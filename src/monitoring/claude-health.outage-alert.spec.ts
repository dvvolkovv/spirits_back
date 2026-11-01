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

  /** Сервис с рубильником switchTo и состоянием запасных; alerted — о простое уже сообщали. */
  const make = (switchTo: AnswerProvider, providers: Provs, alerted = false): any => {
    const pg = { query: jest.fn(async (sql: string) => (/SELECT alerted/.test(sql) ? { rows: [{ alerted }] } : { rows: [] })) };
    const claudeCli = { text: jest.fn(), fallbackStats: jest.fn(() => ({ windowMs: 900_000, providers })) };
    const global = { get: jest.fn(async () => switchTo) };
    return new ClaudeHealthService(pg as any, claudeCli as any, global as any);
  };
  const sent = (): string[] => (sendTelegramPayload as jest.Mock).mock.calls.map((c) => c[0].text);

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
