/**
 * «Всё ещё сломано» — повтор, пока проблему не починят.
 *
 * Почему понадобилось. QualityMonitorService считает провалы за последние 60
 * минут: одно падение 13.08.2026 дало одно сообщение, а дальше никто видео не
 * запрашивал — падений в окне не стало, и алерт замолчал сам. Простой длился
 * неделю не потому, что не было сигнала, а потому что сигнал прозвучал один
 * раз и больше не напоминал о себе.
 *
 * Повтор висит на метке «сломано деньгами», а не на потоке пользовательских
 * задач — именно этим он и отличается от монитора. Снимает метку успешная
 * задача (checkProviderRecovered): спросить квоту Google напрямую нечем.
 *
 * Метки Kling — наследие снятого 22.10.2026 провайдера: их убираем молча.
 */
import { VideoService } from './video.service';

jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => undefined),
  telegramConfigured: () => true,
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendTelegramAlert } = require('../common/telegram-alert');

const BROKEN_KEY = 'video:provider-broken-since';
const DAY = 24 * 3600 * 1000;
const NOW = 1787195374077; // 20.08.2026 06:09 UTC

function makeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); },
    async del(k: string) { store.delete(k); },
  };
}

function svcWith(redis: any) {
  return new (VideoService as any)(
    { async query() { return { rows: [] }; } }, undefined, undefined, redis,
  );
}

const marker = (over: any = {}) => JSON.stringify({ since: NOW - 2 * DAY, provider: 'veo', ...over });

describe('VideoService.remindProviderStillBroken', () => {
  beforeEach(() => (sendTelegramAlert as jest.Mock).mockClear());

  it('без метки молчит', async () => {
    await svcWith(makeRedis()).remindProviderStillBroken(NOW);

    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('пока метка висит — напоминает и называет длительность простоя', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: marker() });
    await svcWith(redis).remindProviderStillBroken(NOW);

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    const text = String((sendTelegramAlert as jest.Mock).mock.calls[0][0]);
    expect(text).toMatch(/всё ещё|все ещё/i);
    expect(text).toMatch(/48 ч|2 дн/i);
    expect(redis.store.has(BROKEN_KEY)).toBe(true);
  });

  it('метку Kling снимает молча — провайдер снят', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: marker({ provider: 'kling' }) });
    await svcWith(redis).remindProviderStillBroken(NOW);

    expect(redis.store.has(BROKEN_KEY)).toBe(false);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('понимает старый формат метки — голое число', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: String(NOW - DAY) });
    await svcWith(redis).remindProviderStillBroken(NOW);

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(String((sendTelegramAlert as jest.Mock).mock.calls[0][0])).toMatch(/24 ч|1 дн/i);
  });

  it('падение телеграма не роняет крон', async () => {
    (sendTelegramAlert as jest.Mock).mockImplementationOnce(async () => { throw new Error('tg down'); });
    const redis = makeRedis({ [BROKEN_KEY]: marker() });

    await expect(svcWith(redis).remindProviderStillBroken(NOW)).resolves.toBeUndefined();
  });
});
