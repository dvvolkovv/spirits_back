/**
 * Отказ провайдера по деньгам должен звенеть.
 *
 * 13.08.2026 Kling начал отвечать `code 1102 Account balance not enough`.
 * Ролик молча уходил в failed, пользователь видел «не получилось», и узнали мы
 * об этом только 20.08, случайно — при разборе списаний. Неделю функция была
 * сломана в тишине.
 *
 * Отсюда два свойства: сигнал уходит именно на денежный отказ (обычная ошибка
 * рендера — не повод будить владельца) и ровно один раз на серию, иначе
 * десяток упавших роликов даст десяток сообщений и их начнут игнорировать.
 */
import { VideoService } from './video.service';

jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => undefined),
  telegramConfigured: () => true,
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendTelegramAlert } = require('../common/telegram-alert');

function makeFakePg() {
  const client = {
    async query(sql: string, params: any[] = []) {
      if (/UPDATE video_jobs SET status='failed'/i.test(sql)) {
        return { rows: [{ image_tokens_spent: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { async getClient() { return client; }, async query() { return { rows: [] }; } } as any;
}

/** Redis в памяти: ключ с TTL — то, на чём держится дедупликация. */
function makeFakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); },
    async del(k: string) { store.delete(k); },
  };
}

describe('VideoService — сигнал о деньгах у провайдера', () => {
  beforeEach(() => (sendTelegramAlert as jest.Mock).mockClear());

  const svcWith = (redis?: any) =>
    new (VideoService as any)(makeFakePg(), undefined, undefined, undefined, undefined, redis);

  it('денежный отказ Kling поднимает тревогу', async () => {
    await svcWith(makeFakeRedis()).failAndRefund(
      'job-1', 'u1', 25000,
      'kling_create: Kling image2video: Account balance not enough (body: {"code":1102})',
    );

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(String((sendTelegramAlert as jest.Mock).mock.calls[0][0])).toMatch(/видео|Kling|провайдер/i);
  });

  it('серия падений подряд даёт один сигнал, а не десять', async () => {
    const svc = svcWith(makeFakeRedis());
    for (let i = 0; i < 5; i++) {
      await svc.failAndRefund(`job-${i}`, 'u1', 25000, 'Account balance not enough (code 1102)');
    }

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('исчерпанная квота Veo — тоже деньги, тоже сигнал', async () => {
    await svcWith(makeFakeRedis()).failAndRefund(
      'job-2', 'u1', 90000, 'veo_start: 429 You exceeded your current quota',
    );

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('обычная ошибка рендера владельца не будит', async () => {
    await svcWith(makeFakeRedis()).failAndRefund('job-3', 'u1', 25000, 'kling: task timeout after 600s');

    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('без Redis сигнал всё равно уходит — дедупликация не важнее уведомления', async () => {
    await svcWith(undefined).failAndRefund('job-4', 'u1', 25000, 'Account balance not enough');

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('возврат денег не зависит от того, ушёл ли сигнал', async () => {
    const redis = { get: async () => { throw new Error('redis down'); }, set: async () => {}, del: async () => {} };

    await expect(
      svcWith(redis).failAndRefund('job-5', 'u1', 25000, 'Account balance not enough'),
    ).resolves.toBeUndefined();
  });
});
