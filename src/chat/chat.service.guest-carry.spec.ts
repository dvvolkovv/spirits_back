import 'reflect-metadata';
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { clockRedis } from '../auth/fake-redis.forspec';
import { guestCarryKey } from '../guest-trial/guest-carry';
import { RedisService } from '../common/services/redis.service';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Проба без входа (spec 2026-10-30-guest-trial): аккаунту с прошлой сессией у
 * ассистента пересказ пробы уходит ОДИН раз — в тело реплики к релею.
 */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const OLD_SECRET = process.env.JWT_SECRET;
const realSetTimeout = global.setTimeout;
beforeAll(() => {
  process.env.JWT_SECRET = 'guest-carry-spec';
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => {
  (global as any).setTimeout = realSetTimeout;
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_SECRET;
});
beforeEach(() => jest.clearAllMocks());

function harness(withRedis = true) {
  const pg = { query: jest.fn(async (sql: string) => (/AS spent/.test(sql) ? { rows: [{ spent: 0 }] } : { rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const ev = { track: jest.fn() };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, ev as any, undefined);
  const redis = clockRedis();
  // Позиционная сборка до последнего параметра не доходит — подставляем полем.
  if (withRedis) (svc as any).redis = redis;
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) }));
  (axios.get as jest.Mock).mockImplementation(async () => ({ data: [] }));
  const run = async (message: string, fresh = false) => {
    post.mockClear();
    const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
    await (svc as any).streamUniversalAgent(
      'u-test', message, '12', '12', [], '', res, 'Роман', '', '', undefined, fresh,
      fresh ? 'u-test_12_fresh_1' : undefined,
    );
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    return fieldsOf(post.mock.calls[0][1]).message;
  };
  return { run, redis };
}

describe('streamUniversalAgent: приписка о пробе', () => {
  it('уходит в реплику один раз и стирается', async () => {
    const h = harness();
    await h.redis.set(guestCarryKey('u-test', '12'), '--- Разговор до входа ---\nЧеловек: Как поднять цены?', 3600);
    const first = await h.run('Продолжим?');
    expect(first).toContain('Человек: Как поднять цены?');
    expect(first.endsWith('Продолжим?')).toBe(true);
    expect(h.redis.peek(guestCarryKey('u-test', '12'))).toBeNull();
    expect(await h.run('И ещё')).not.toContain('Разговор до входа');
  });

  it('«чистый лист» приписку не забирает', async () => {
    const h = harness();
    await h.redis.set(guestCarryKey('u-test', '12'), 'ПРИПИСКА', 3600);
    expect(await h.run('Новая тема', true)).not.toContain('ПРИПИСКА');
    expect(h.redis.peek(guestCarryKey('u-test', '12'))).toBe('ПРИПИСКА');
  });

  it('без Redis (спеки и урезанные сборки) ход идёт как раньше', async () => {
    const h = harness(false);
    const message = await h.run('Привет');
    expect(message.endsWith('Привет')).toBe(true);
    expect(message).not.toContain('Разговор до входа');
  });
});

/**
 * Контролёр A9, пункт 1: в конструкторе ChatService зависимость должна быть
 * объявлена КЛАССОМ RedisService, а не интерфейсом CarryStore. Интерфейс
 * стирается в Object при компиляции в JS — Nest не найдёт провайдер по типу
 * Object, @Optional() молча подставит undefined, и на проде приписка никогда
 * не сработает. Три теста выше этого не заметят: harness подставляет redis
 * полем в обход DI-контейнера. Сторож по духу chat.module.chat-files.spec.ts
 * (там — состав ChatModule), но здесь — design:paramtypes самого ChatService.
 */
describe('ChatService: DI-тип приписки о пробе', () => {
  it('конструктор объявляет зависимость классом RedisService, а не интерфейсом', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', ChatService);
    expect(Array.isArray(paramTypes)).toBe(true);
    expect(paramTypes).toContain(RedisService);
  });
});
