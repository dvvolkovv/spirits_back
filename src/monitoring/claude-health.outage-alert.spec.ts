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

/**
 * Алерт «Локальный Claude CLI недоступен» знает об общем рубильнике (ревью
 * 01.11, R3). Пока рубильник не на Claude, Маша, TG-боты и фоновые задачи
 * отвечают через его модель — падение Claude задевает только пробы
 * мониторинга (они всегда на Claude), личный выбор Claude и запасной путь.
 * Без ключа модель рубильника фактически не действует (все на Claude) — текст
 * прежний, как «фактически отвечает Claude» в суточном напоминании.
 */
describe('ClaudeHealthService — алерт о падении CLI и рубильник', () => {
  const ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'QWEN_FALLBACK_API_KEY', 'KIMI_FALLBACK_API_KEY'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.TELEGRAM_BOT_TOKEN = 'tg-test';
    process.env.TELEGRAM_CHAT_ID = 'chat-test';
    process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    (sendTelegramPayload as jest.Mock).mockClear();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  /** Текст алерта о падении при рубильнике на switchTo. */
  const alertText = async (switchTo: 'claude' | 'qwen' | 'kimi'): Promise<string> => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const claudeCli = { text: jest.fn(), fallbackStats: jest.fn(() => ({ windowMs: 900_000 })) };
    const global = { get: jest.fn(async () => switchTo) };
    const svc: any = new ClaudeHealthService(pg as any, claudeCli as any, global as any);
    svc.cache.llmStatus = 'down';
    svc.cache.llmOutageKind = 'auth';
    svc.cache.llmError = 'не вошёл';
    // С запасом выше порога подряд-провалов (CLAUDE_OUTAGE_FAILS из окружения).
    svc.cliConsecutiveDown = 99;
    await svc.maybeAlertOutage();
    expect(sendTelegramPayload).toHaveBeenCalledTimes(1);
    return (sendTelegramPayload as jest.Mock).mock.calls[0][0].text;
  };

  it('рубильник на Claude — прежний текст «Затронуто»', async () => {
    const text = await alertText('claude');
    expect(text).toContain(
      'Затронуто: <b>Маша, TG-боты, Виртуальный PM, Виртуальный маркетолог, фоновые задачи</b> (CLI-путь на OAuth-подписке).',
    );
    expect(text).not.toContain('рубильник');
  });

  it('рубильник на Qwen — затронуты пробы мониторинга, личный выбор Claude и запасной путь', async () => {
    const text = await alertText('qwen');
    expect(text).toContain(
      'Затронуто: пробы мониторинга, личный выбор Claude и запасной путь — рубильник сейчас на <b>Qwen</b>: ' +
        'Маша, TG-боты и фоновые задачи отвечают через эту модель.',
    );
    expect(text).not.toContain('Виртуальный маркетолог');
    // Остальное в алерте — как было.
    expect(text).toContain('Локальный Claude CLI недоступен');
    expect(text).toContain('Чат-ассистенты (r.linkeon.io) — отдельный путь');
  });

  it('рубильник на Kimi — подпись Kimi', async () => {
    expect(await alertText('kimi')).toContain('рубильник сейчас на <b>Kimi</b>');
  });

  it('рубильник на Kimi без ключа на сервере — фактически все на Claude, текст прежний', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const text = await alertText('kimi');
    expect(text).toContain('Затронуто: <b>Маша, TG-боты, Виртуальный PM, Виртуальный маркетолог, фоновые задачи</b>');
    expect(text).not.toContain('рубильник');
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
