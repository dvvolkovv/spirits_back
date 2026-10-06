import { RedisService } from '../common/services/redis.service';
import { QuotaReply, QuotaRule, takeQuota } from './quota';
import { firstInWindow } from './limit-alert';
import { clockRedis } from './fake-redis.forspec';

/**
 * QUOTA_SCRIPT (quota.ts) против живого Redis — и сверка с JS-двойником из
 * fake-redis.forspec.ts, на котором стоят спеки лимитов SMS и писем. Если
 * двойник разойдётся со скриптом, те спеки проверяли бы не то, что работает
 * на проде; здесь каждый сценарий гоняется на обоих и сравнивается.
 *
 * КАК ГОНЯТЬ. Нужен одноразовый redis-server (на проде redis:7):
 *
 *   redis-server --port 0 --unixsocket /tmp/quota-test.sock --save '' \
 *     --appendonly no --daemonize yes --pidfile /tmp/quota-test.pid
 *   QUOTA_REDIS_URL=/tmp/quota-test.sock npx jest src/auth/quota.redis.spec.ts
 *   redis-cli -s /tmp/quota-test.sock shutdown nosave
 *
 * Ключи — с уникальным префиксом и удаляются за собой, но гонять всё равно
 * только на одноразовом сервере. Без QUOTA_REDIS_URL набор пропускается.
 */

const URL = process.env.QUOTA_REDIS_URL;
const maybe = URL ? describe : describe.skip;

/** Сколько реального времени проходит между командами — допуск на остаток окна. */
const SLACK_MS = 2000;

maybe('QUOTA_SCRIPT против живого Redis', () => {
  let redis: RedisService;
  let client: any;
  const used: string[] = [];
  const savedUrl = process.env.REDIS_URL;
  let n = 0;

  beforeAll(() => {
    process.env.REDIS_URL = URL;
    redis = new RedisService();
    redis.onModuleInit();
    client = (redis as any).client;
  });
  afterAll(async () => {
    if (used.length) await client.del(...used);
    await redis.onModuleDestroy();
    if (savedUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = savedUrl;
  });

  /** Два свежих правила с уникальными ключами: A — 2 за минуту, B — 5 за час. */
  function rules(): QuotaRule[] {
    const p = `quota-test:${process.pid}:${Date.now()}:${n++}`;
    const r = [
      { key: `${p}:a`, max: 2, windowSec: 60 },
      { key: `${p}:b`, max: 5, windowSec: 3600 },
    ];
    used.push(...r.map((x) => x.key));
    return r;
  }

  /** Одни и те же шаги на живом Redis и на двойнике. */
  function both() {
    const fake = clockRedis();
    return {
      fake,
      take: async (r: QuotaRule[]) => [await takeQuota(redis, r), await takeQuota(fake, r)] as [QuotaReply, QuotaReply],
      setRaw: async (key: string, value: string) => { await client.set(key, value); await fake.set(key, value); },
      state: async (key: string) => ({
        live: { value: await client.get(key), pttl: Number(await client.pttl(key)) },
        fake: { value: fake.peek(key), pttl: await fake.pttl(key) },
      }),
    };
  }

  /** Ответы совпадают: учтено/нет и остатки окон (живой Redis — минус прошедшие мс). */
  function expectSameReply([live, fake]: [QuotaReply, QuotaReply]) {
    expect(live.counted).toBe(fake.counted);
    if (live.counted || fake.counted) return;
    expect(live.leftMs.map((ms) => ms >= 0)).toEqual(fake.leftMs.map((ms) => ms >= 0));
    live.leftMs.forEach((ms, i) => {
      if (ms < 0) return;
      expect(ms).toBeLessThanOrEqual(fake.leftMs[i]);
      expect(ms).toBeGreaterThan(fake.leftMs[i] - SLACK_MS);
    });
  }

  /** Состояние ключа совпадает: значение и есть ли срок (сам срок — с допуском). */
  async function expectSameState(env: ReturnType<typeof both>, key: string) {
    const { live, fake } = await env.state(key);
    expect(live.value).toBe(fake.value);
    expect(Math.sign(live.pttl)).toBe(Math.sign(fake.pttl));
    if (live.pttl > 0) expect(live.pttl).toBeGreaterThan(fake.pttl - SLACK_MS);
  }

  it('пусто — учтено во всех окнах, срок каждого счётчика — его окно', async () => {
    const env = both();
    const r = rules();
    const reply = await env.take(r);
    expect(reply[0]).toEqual({ counted: true, leftMs: [] });
    expectSameReply(reply);
    for (const { key } of r) await expectSameState(env, key);
    expect(Number(await client.pttl(r[1].key))).toBeGreaterThan(3600_000 - SLACK_MS);
  });

  it('заполненное окно — отказ с остатками окон и без единой записи', async () => {
    const env = both();
    const r = rules();
    expectSameReply(await env.take(r));
    expectSameReply(await env.take(r));
    const refused = await env.take(r);
    expect(refused[0].counted).toBe(false);
    expect(refused[0].leftMs[1]).toBe(-1);
    expectSameReply(refused);
    for (const { key } of r) await expectSameState(env, key);
    expect(await client.get(r[0].key)).toBe('2');
    expect(await client.get(r[1].key)).toBe('2');
  });

  it('заполненный счётчик без срока — отказ ставит ему срок окна', async () => {
    const env = both();
    const r = rules();
    await env.setRaw(r[0].key, '2');
    const refused = await env.take(r);
    expect(refused[0].leftMs[0]).toBe(60_000);
    expectSameReply(refused);
    await expectSameState(env, r[0].key);
    expect(await client.exists(r[1].key)).toBe(0);
  });

  it('незаполненный счётчик без срока — учёт ставит ему срок окна', async () => {
    const env = both();
    const r = rules();
    await env.setRaw(r[1].key, '1');
    expectSameReply(await env.take(r));
    await expectSameState(env, r[1].key);
    expect(await client.get(r[1].key)).toBe('2');
  });

  it('мусор в счётчике — ошибка до единой записи', async () => {
    const env = both();
    const r = rules();
    await env.setRaw(r[1].key, 'abc');
    await expect(takeQuota(redis, r)).rejects.toThrow();
    await expect(takeQuota(env.fake, r)).rejects.toThrow();
    await expectSameState(env, r[0].key);
    expect(await client.exists(r[0].key)).toBe(0);
  });

  it('двадцать запросов разом — учтено ровно по порогу', async () => {
    const r = [{ ...rules()[1], max: 5 }];
    const replies = await Promise.all(Array.from({ length: 20 }, () => takeQuota(redis, r)));
    expect(replies.filter((x) => x.counted)).toHaveLength(5);
    expect(await client.get(r[0].key)).toBe('5');
  });

  it('отметка «раз за окно» (SET NX PX): первый — да, второй — нет, срок — остаток окна', async () => {
    const key = rules()[0].key;
    expect(await firstInWindow(redis, key, 30_000)).toBe(true);
    expect(await firstInWindow(redis, key, 30_000)).toBe(false);
    const pttl = Number(await client.pttl(key));
    expect(pttl).toBeGreaterThan(30_000 - SLACK_MS);
    expect(pttl).toBeLessThanOrEqual(30_000);
  });
});
