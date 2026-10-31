import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { MODULE_METADATA, OPTIONAL_DEPS_METADATA } from '@nestjs/common/constants';
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => undefined),
  telegramConfigured: jest.fn(() => true),
}));
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { GlobalLlmReminderService } from './global-llm-reminder.service';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { ClaudeHealthService } from './claude-health.service';
import { PgService } from '../common/services/pg.service';
import { MonitoringModule } from './monitoring.module';

const health = (llmStatus: 'ok' | 'down' | null) => ({
  getOverview: jest.fn(async () => ({ usage: { llmStatus, llmCheckedAt: '2026-10-31T06:45:00Z' } })),
});
/** pg с суточным счётом по вызовам рубильника: четыре числа (новая форма, ревью 01.11). */
const pgDay = (answered = 0, byOther = 0, failed = 0, guests = 0) => ({
  query: jest.fn(async () => ({ rows: [{ answered, by_other: byOther, failed, guests }] })),
});

describe('GlobalLlmReminderService', () => {
  const OLD = process.env.KIMI_FALLBACK_API_KEY;
  afterEach(() => {
    (sendTelegramAlert as jest.Mock).mockClear();
    (sendTelegramAlert as jest.Mock).mockImplementation(async () => undefined);
    (telegramConfigured as jest.Mock).mockClear();
    (telegramConfigured as jest.Mock).mockImplementation(() => true);
    if (OLD === undefined) delete process.env.KIMI_FALLBACK_API_KEY; else process.env.KIMI_FALLBACK_API_KEY = OLD;
  });

  it('рубильник на Claude — молчит', async () => {
    const g = { status: jest.fn(async () => ({ provider: 'claude', since: null, by: null })) };
    const pg = pgDay();
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pg as any);
    expect(await s.remind(new Date('2026-10-31T07:00:00Z'))).toBe(false);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('рубильник на Kimi без ключа — напоминание с пометкой «фактически Claude»', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: '2026-10-30T07:00:00Z', by: 'admin-1' })) };
    const s = new GlobalLlmReminderService(g as any, health('down') as any, pgDay() as any);
    expect(await s.remind(new Date('2026-10-31T07:00:00Z'))).toBe(true);
    const text = (sendTelegramAlert as jest.Mock).mock.calls[0][0];
    expect(text).toContain('Все отвечают через Kimi');
    expect(text).toContain('Claude по последней пробе: не отвечает');
    expect(text).toContain('фактически отвечает Claude');
  });

  it('счёт за сутки — три числа (ответила/ответил другой/без ответа) и гости', async () => {
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const pg = pgDay(50, 3, 2, 1);
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pg as any);
    await s.remind();
    const [sql, params] = (pg.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/props->>'choice' = 'global'/);
    expect(sql).toMatch(/props->>'selected' = \$1/);
    expect(sql).toMatch(/props->>'ok'/);
    expect(sql).toMatch(/guest_trial_error/);
    expect(params).toEqual(['kimi']);
    // без ответа — 2 (из chat_quality) + 1 (гость) = 3; из них гостям — 1.
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).toContain(
      'За сутки через Kimi: ответила — 50; ответил другой — 3; без ответа — 3 (из них гостям — 1).',
    );
  });

  // Ревью 01.11 (R2): гостевой internal — сбой базы уже после ответа модели,
  // а не «без ответа» от неё; в счёт гостей идут только breaker и model.
  it('гости в счёте — только ошибки о модели (breaker, model), без internal', async () => {
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const pg = pgDay();
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pg as any);
    await s.remind();
    const [sql] = (pg.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/props->>'reason' IN \('breaker', 'model'\)/);
    expect(sql).not.toMatch(/internal/);
  });

  it('сбой счёта — напоминание уходит без строки «За сутки»', async () => {
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const pg = { query: jest.fn(async () => { throw new Error('db down'); }) };
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pg as any);
    expect(await s.remind()).toBe(true);
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).not.toContain('За сутки');
  });

  it('сбой статуса — молчит, не бросает', async () => {
    const g = { status: jest.fn(async () => { throw new Error('db down'); }) };
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pgDay() as any);
    await expect(s.remind()).resolves.toBe(false);
  });

  it('сбой обзора здоровья — напоминание всё равно уходит, «нет данных»', async () => {
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const h = { getOverview: jest.fn(async () => { throw new Error('boom'); }) };
    const s = new GlobalLlmReminderService(g as any, h as any, pgDay() as any);
    expect(await s.remind()).toBe(true);
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).toContain('нет данных');
  });

  it('Telegram не настроен — пишет текст напоминания в лог, не бросает', async () => {
    (telegramConfigured as jest.Mock).mockImplementation(() => false);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pgDay() as any);
    expect(await s.remind()).toBe(true);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Все отвечают через Kimi');
    warn.mockRestore();
  });
});

describe('GlobalLlmReminderService: регистрация', () => {
  it('зарегистрирован в MonitoringModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MonitoringModule)).toContain(GlobalLlmReminderService);
  });
});

/**
 * Раз в сутки в 10:01 МСК — не в 10:00: тик пробы живости Claude каждые
 * 15 минут (ClaudeHealthService.livenessTick) уже занимает этот момент,
 * совпадение затрудняло бы читать логи (ревью 01.11).
 */
describe('GlobalLlmReminderService: расписание', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SCHEDULE_CRON_OPTIONS } = require('@nestjs/schedule/dist/schedule.constants');
  it('раз в сутки в 10:01 МСК', () => {
    const meta = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, GlobalLlmReminderService.prototype.daily);
    expect(meta?.cronTime).toBe('0 1 10 * * *');
    expect(meta?.timeZone).toBe('Europe/Moscow');
  });
});

/**
 * Суточное напоминание не должно молча перестать напоминать, если граф DI не
 * нашёл один из сервисов: все три зависимости — обязательные, без
 * @Optional(). design:paramtypes не видит сам декоратор, но фиксирует, что
 * параметры объявлены классами (а не интерфейсом/Object) — необходимое
 * условие, чтобы Nest вообще мог найти провайдер по типу (тот же приём, что
 * в src/chat/llm-provider-di.spec.ts).
 */
describe('GlobalLlmReminderService: DI-тип', () => {
  it('конструктор объявляет зависимости классами GlobalLlmProviderService, ClaudeHealthService, PgService', () => {
    expect(Reflect.getMetadata('design:paramtypes', GlobalLlmReminderService)).toEqual([GlobalLlmProviderService, ClaudeHealthService, PgService]);
  });

  it('без @Optional() — ни один параметр не помечен необязательным', () => {
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, GlobalLlmReminderService)).toBeUndefined();
  });
});
