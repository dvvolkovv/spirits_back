/**
 * После починки должно прийти подтверждение, что видео снова работает.
 *
 * Сейчас цикл разомкнут: тревога «у провайдера кончились деньги» уходит, а
 * дальше тишина — и она читается одинаково и когда всё починили, и когда никто
 * ничего не сделал. Владелец спросил ровно это: «почему не пришёл алерт, что
 * всё хорошо с видео?».
 *
 * Ключевая тонкость — срок. У ключа дедупликации TTL шесть часов (он глушит
 * повторные тревоги), и если вешать восстановление на него же, то починка
 * через сутки останется без подтверждения. Поэтому «сломано» помечается
 * отдельным ключом без TTL, который снимается только фактом успешной задачи.
 */
import { VideoService } from './video.service';

jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => undefined),
  telegramConfigured: () => true,
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendTelegramAlert } = require('../common/telegram-alert');

const BROKEN_KEY = 'video:provider-broken-since';

function makeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); },
    async del(k: string) { store.delete(k); },
  };
}

/** pg, который отвечает на «сколько задач стало ready после метки». */
function makePg(readyAfter: number) {
  return {
    queries: [] as any[],
    async query(sql: string, params: any[] = []) {
      (this as any).queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: readyAfter }] };
      return { rows: [] };
    },
    async getClient() { return { query: async () => ({ rows: [], rowCount: 0 }), release() {} }; },
  } as any;
}

const svcWith = (pg: any, redis: any) =>
  new (VideoService as any)(pg, undefined, undefined, undefined, undefined, redis);

describe('VideoService — подтверждение, что видео снова работает', () => {
  beforeEach(() => (sendTelegramAlert as jest.Mock).mockClear());

  it('успешная задача после тревоги — присылает подтверждение и снимает метку', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: String(Date.now() - 3600_000) });
    await svcWith(makePg(1), redis).checkProviderRecovered();

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(String((sendTelegramAlert as jest.Mock).mock.calls[0][0])).toMatch(/снова работает|восстанов/i);
    expect(redis.store.has(BROKEN_KEY)).toBe(false);
  });

  it('починка через сутки тоже подтверждается — метка без TTL', async () => {
    const dayAgo = String(Date.now() - 24 * 3600_000);
    const redis = makeRedis({ [BROKEN_KEY]: dayAgo });
    await svcWith(makePg(1), redis).checkProviderRecovered();

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('пока успешных задач нет — молчит и метку держит', async () => {
    const redis = makeRedis({ [BROKEN_KEY]: String(Date.now() - 3600_000) });
    await svcWith(makePg(0), redis).checkProviderRecovered();

    expect(sendTelegramAlert).not.toHaveBeenCalled();
    expect(redis.store.has(BROKEN_KEY)).toBe(true);
  });

  it('без тревоги в базу не ходит вовсе', async () => {
    const pg = makePg(5);
    await svcWith(pg, makeRedis()).checkProviderRecovered();

    expect(sendTelegramAlert).not.toHaveBeenCalled();
    expect(pg.queries).toHaveLength(0);
  });

  it('без Redis молчит и не падает — состояние хранить негде', async () => {
    await expect(svcWith(makePg(1), undefined).checkProviderRecovered()).resolves.toBeUndefined();
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('падение телеграма не роняет опрос задач', async () => {
    (sendTelegramAlert as jest.Mock).mockImplementationOnce(async () => { throw new Error('tg down'); });
    const redis = makeRedis({ [BROKEN_KEY]: String(Date.now() - 60_000) });

    await expect(svcWith(makePg(1), redis).checkProviderRecovered()).resolves.toBeUndefined();
  });

  it('тревога ставит метку «сломано» — иначе восстанавливать будет нечего', async () => {
    const redis = makeRedis();
    await svcWith(makePg(0), redis).alertProviderOutOfMoney('Account balance not enough (code 1102)');

    expect(redis.store.has(BROKEN_KEY)).toBe(true);
  });
});
