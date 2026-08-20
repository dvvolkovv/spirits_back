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
 * задач — именно этим он и отличается от монитора.
 *
 * Вторая половина задачи: не бубнить после тихой починки. Восстановление
 * ловится успешной задачей, но если счёт пополнили, а видео никто не заказывал,
 * успешной задачи не будет — и напоминание шло бы вечно. Поэтому перед каждым
 * повтором спрашиваем провайдера напрямую.
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

/** packs: null = спросить не удалось. */
function svcWith(redis: any, packs: any[] | null) {
  const kling = { getResourcePacks: jest.fn(async () => packs) };
  return new (VideoService as any)(
    { async query() { return { rows: [] }; } }, kling, undefined, undefined, undefined, redis,
  );
}

const livePack = { name: 'Trial', total: 100, remaining: 98, expiresAt: NOW + 30 * DAY, status: 'online' };
const deadPack = { name: 'Trial', total: 100, remaining: 94, expiresAt: NOW - DAY, status: 'expired' };

const marker = (over: any = {}) => JSON.stringify({ since: NOW - 2 * DAY, provider: 'kling', ...over });

describe('VideoService.remindProviderStillBroken', () => {
  beforeEach(() => (sendTelegramAlert as jest.Mock).mockClear());

  it('без метки молчит и провайдера не дёргает', async () => {
    const svc = svcWith(makeRedis(), [livePack]);
    await svc.remindProviderStillBroken(NOW);

    expect(sendTelegramAlert).not.toHaveBeenCalled();
    expect((svc as any).kling.getResourcePacks).not.toHaveBeenCalled();
  });

  it('пока живого пакета нет — напоминает и называет длительность простоя', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: marker() });
    await svcWith(redis, [deadPack]).remindProviderStillBroken(NOW);

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    const text = String((sendTelegramAlert as jest.Mock).mock.calls[0][0]);
    expect(text).toMatch(/всё ещё|все ещё/i);
    expect(text).toMatch(/48 ч|2 дн/i);
    expect(redis.store.has(BROKEN_KEY)).toBe(true);
  });

  it('счёт пополнен — снимает метку сам, не дожидаясь чужой задачи', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: marker() });
    await svcWith(redis, [livePack]).remindProviderStillBroken(NOW);

    expect(redis.store.has(BROKEN_KEY)).toBe(false);
    expect(String((sendTelegramAlert as jest.Mock).mock.calls[0][0])).toMatch(/пополнен|снова работает/i);
  });

  it('пакет живой, но пустой — это не починка', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: marker() });
    await svcWith(redis, [{ ...livePack, remaining: 0 }]).remindProviderStillBroken(NOW);

    expect(redis.store.has(BROKEN_KEY)).toBe(true);
    expect(String((sendTelegramAlert as jest.Mock).mock.calls[0][0])).toMatch(/всё ещё|все ещё/i);
  });

  it('метка от Veo живым пакетом Kling не снимается — это разные провайдеры', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: marker({ provider: 'veo' }) });
    await svcWith(redis, [livePack]).remindProviderStillBroken(NOW);

    expect(redis.store.has(BROKEN_KEY)).toBe(true);
    expect(String((sendTelegramAlert as jest.Mock).mock.calls[0][0])).toMatch(/всё ещё|все ещё/i);
  });

  it('провайдера спросить не удалось — напоминает, а не молчит', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: marker() });
    await svcWith(redis, null).remindProviderStillBroken(NOW);

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(redis.store.has(BROKEN_KEY)).toBe(true);
  });

  it('понимает старый формат метки — голое число', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: String(NOW - DAY) });
    await svcWith(redis, [deadPack]).remindProviderStillBroken(NOW);

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(String((sendTelegramAlert as jest.Mock).mock.calls[0][0])).toMatch(/24 ч|1 дн/i);
  });

  it('падение телеграма не роняет крон', async () => {
    (sendTelegramAlert as jest.Mock).mockImplementationOnce(async () => { throw new Error('tg down'); });
    const redis = makeRedis({ [BROKEN_KEY]: marker() });

    await expect(svcWith(redis, [deadPack]).remindProviderStillBroken(NOW)).resolves.toBeUndefined();
  });
});
