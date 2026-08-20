/**
 * Денежный отказ провайдера помечается, но НЕ шлёт своего сообщения.
 *
 * История правки: 20.08.2026 я добавил сюда отдельную телеграм-тревогу, решив,
 * что провалы видео нигде не звенят. Это было неверно — QualityMonitorService
 * ловит их с июля: считает провалы по balance/quota за 60 минут и шлёт
 * «⚠️ КАЧЕСТВО: платный провайдер отказывает пользователям» в тот же чат,
 * с кулдауном 3 часа. Мой сигнал давал второе сообщение о том же событии, то
 * есть ровно ту усталость от алертов, которой я и пытался избежать.
 *
 * Что осталось здесь: пометка «сломано деньгами» без TTL. У монитора её нет, а
 * без неё нечем подтвердить починку — см. video.provider-recovery.spec.
 */
import { VideoService } from './video.service';

jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => undefined),
  telegramConfigured: () => true,
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendTelegramAlert } = require('../common/telegram-alert');

const BROKEN_KEY = 'video:provider-broken-since';

function makeFakePg() {
  const client = {
    async query(sql: string) {
      if (/UPDATE video_jobs SET status='failed'/i.test(sql)) {
        return { rows: [{ image_tokens_spent: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { async getClient() { return client; }, async query() { return { rows: [] }; } } as any;
}

function makeFakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); },
    async del(k: string) { store.delete(k); },
  };
}

describe('VideoService — денежный отказ провайдера', () => {
  beforeEach(() => (sendTelegramAlert as jest.Mock).mockClear());

  const svcWith = (redis?: any) =>
    new (VideoService as any)(makeFakePg(), undefined, undefined, undefined, undefined, redis);

  it('ставит метку «сломано» — по ней потом подтвердится починка', async () => {
    const redis = makeFakeRedis();
    await svcWith(redis).failAndRefund(
      'job-1', 'u1', 25000,
      'kling_create: Kling image2video: Account balance not enough (body: {"code":1102})',
    );

    expect(redis.store.has(BROKEN_KEY)).toBe(true);
  });

  it('своего сообщения не шлёт — о провалах уже сообщает QualityMonitor', async () => {
    await svcWith(makeFakeRedis()).failAndRefund('job-1', 'u1', 25000, 'Account balance not enough (code 1102)');

    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('исчерпанная квота Veo — тоже денежный отказ, тоже метка', async () => {
    const redis = makeFakeRedis();
    await svcWith(redis).failAndRefund('job-2', 'u1', 90000, 'veo_start: 429 You exceeded your current quota');

    expect(redis.store.has(BROKEN_KEY)).toBe(true);
  });

  it('обычная ошибка рендера метку не ставит', async () => {
    const redis = makeFakeRedis();
    await svcWith(redis).failAndRefund('job-3', 'u1', 25000, 'kling: task timeout after 600s');

    expect(redis.store.has(BROKEN_KEY)).toBe(false);
  });

  it('серия падений подряд метку не сбрасывает и не плодит записей', async () => {
    const redis = makeFakeRedis();
    const svc = svcWith(redis);
    for (let i = 0; i < 5; i++) {
      await svc.failAndRefund(`job-${i}`, 'u1', 25000, 'Account balance not enough');
    }

    expect(redis.store.size).toBeLessThanOrEqual(2); // метка + дедуп-ключ
    expect(redis.store.has(BROKEN_KEY)).toBe(true);
  });

  it('без Redis возврат всё равно проходит', async () => {
    await expect(
      svcWith(undefined).failAndRefund('job-4', 'u1', 25000, 'Account balance not enough'),
    ).resolves.toBeUndefined();
  });

  it('падение Redis не роняет возврат денег', async () => {
    const redis = { get: async () => { throw new Error('redis down'); }, set: async () => {}, del: async () => {} };

    await expect(
      svcWith(redis).failAndRefund('job-5', 'u1', 25000, 'Account balance not enough'),
    ).resolves.toBeUndefined();
  });
});
