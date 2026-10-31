import 'reflect-metadata';
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => undefined) }));
import { sendTelegramAlert } from '../common/telegram-alert';
import { GlobalLlmReminderService } from './global-llm-reminder.service';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { ClaudeHealthService } from './claude-health.service';
import { PgService } from '../common/services/pg.service';

const health = (llmStatus: 'ok' | 'down' | null) => ({
  getOverview: jest.fn(async () => ({ usage: { llmStatus, llmCheckedAt: '2026-10-31T06:45:00Z' } })),
});
/** pg с суточным счётом ответов по выбору рубильника. */
const pgDay = (ok = 0, other = 0) => ({ query: jest.fn(async () => ({ rows: [{ ok, other }] })) });

describe('GlobalLlmReminderService', () => {
  const OLD = process.env.KIMI_FALLBACK_API_KEY;
  afterEach(() => {
    (sendTelegramAlert as jest.Mock).mockClear();
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

  it('счёт за сутки — по событиям с choice=global и selected модели рубильника', async () => {
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const pg = pgDay(57, 2);
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pg as any);
    await s.remind();
    const [sql, params] = (pg.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/props->>'choice' = 'global'/);
    expect(sql).toMatch(/name IN \('chat_quality', 'claude_cli_call'\)/);
    expect(params).toEqual(['kimi']);
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).toContain('За сутки через Kimi: 57 вызовов (ответы людям и фоновые задачи); не ответила, ответил другой — 2');
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
});

/**
 * Суточное напоминание падает молча без effective-данных, если граф DI не
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
});
