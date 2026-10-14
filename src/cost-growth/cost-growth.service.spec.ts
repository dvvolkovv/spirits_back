import { CostGrowthService, formatCostGrowthAlert, pairKey, type CostPair } from './cost-growth.service';
import { sendTelegramAlert } from '../common/telegram-alert';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
const mockedAlert = sendTelegramAlert as jest.Mock;

/**
 * Поддельный Redis: eval повторяет смысл Lua-скрипта сервиса (RPUSH, LTRIM
 * до последних N, EXPIRE, LRANGE), setNx — SET NX. Сам Lua проверяется на
 * настоящем Redis тестового стенда (Task 6).
 */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const ttl = new Map<string, number>();
  const flags = new Map<string, string>();
  return {
    lists, ttl, flags,
    eval: jest.fn(async (_script: string, keys: string[], args: Array<string | number>) => {
      const [key] = keys;
      const [value, keep, ttlSec] = args;
      const list = [...(lists.get(key) ?? []), String(value)].slice(-Number(keep));
      lists.set(key, list);
      ttl.set(key, Number(ttlSec));
      return list;
    }),
    setNx: jest.fn(async (key: string, value: string, _ms: number) => {
      if (flags.has(key)) return false;
      flags.set(key, value);
      return true;
    }),
  };
}

const CHAT: CostPair = { kind: 'chat', userId: 'u1', assistantId: '14' };
const TG: CostPair = { kind: 'tg', configId: 'cfg-1', chatId: '-100123', payerUserId: 'u-owner', botName: 'Финансист' };
const GROWING = [420, 610, 980, 1650, 2900];

async function feed(svc: CostGrowthService, pair: CostPair, tokens: number[], balance?: number) {
  for (const t of tokens) {
    await svc.recordTurn(pair, { tokens: t, usd: t / 3600, note: `implied=$${(t / 3600).toFixed(4)}` }, balance === undefined ? undefined : { balance: async () => balance });
  }
}

describe('CostGrowthService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('пятый растущий ход будит, один алерт', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, CHAT, GROWING, 41_300);
    expect(mockedAlert).toHaveBeenCalledTimes(1);
    const text = String(mockedAlert.mock.calls[0][0]);
    expect(text).toContain('Стоимость растёт с каждым ответом');
    expect(text).toContain('<code>u1</code>');
    expect(text).toContain('ассистент 14');
    expect(text).toContain('×6,9');
    expect(text).toContain('Остаток:');
  });

  it('пауза: продолжение роста в те же сутки не будит второй раз', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, CHAT, [...GROWING, 4000, 6000]);
    expect(mockedAlert).toHaveBeenCalledTimes(1);
  });

  it('пары не мешают друг другу: свой счёт у каждого ассистента', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    const other: CostPair = { kind: 'chat', userId: 'u1', assistantId: '7' };
    for (let i = 0; i < GROWING.length; i++) {
      await feed(svc, CHAT, [GROWING[i]]);
      await feed(svc, other, [3000 - i * 100]);
    }
    expect(mockedAlert).toHaveBeenCalledTimes(1);
    expect(String(mockedAlert.mock.calls[0][0])).toContain('ассистент 14');
  });

  it('история — последние 10 ходов, хранится сутки', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, CHAT, [5, 4, 3, 2, 1, 5, 4, 3, 2, 1, 5, 4]);
    const key = `cost-growth:turns:${pairKey(CHAT)}`;
    expect(redis.lists.get(key)).toHaveLength(10);
    expect(redis.ttl.get(key)).toBe(24 * 3600);
  });

  it('нулевой ход не записывается и серию не рвёт', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, CHAT, [420, 610, 0, 980, 1650, 0, 2900]);
    expect(redis.lists.get(`cost-growth:turns:${pairKey(CHAT)}`)).toHaveLength(5);
    expect(mockedAlert).toHaveBeenCalledTimes(1);
  });

  it('TG-пара: ключ по боту и чату, в алерте — кто платит', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, TG, GROWING);
    expect(pairKey(TG)).toBe('tg:cfg-1:-100123');
    const text = String(mockedAlert.mock.calls[0][0]);
    expect(text).toContain('TG-бот');
    expect(text).toContain('«Финансист»');
    expect(text).toContain('платит <code>u-owner</code>');
  });

  it('сбой Redis не бросает и не будит', async () => {
    const redis = { eval: jest.fn(async () => { throw new Error('Connection is closed'); }), setNx: jest.fn() };
    const svc = new CostGrowthService(redis as any);
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    await expect(svc.recordTurn(CHAT, { tokens: 500, usd: 0.14 })).resolves.toBeUndefined();
    expect(mockedAlert).not.toHaveBeenCalled();
    expect((svc as any).logger.warn).toHaveBeenCalled();
  });

  it('сбой отправки алерта не бросает', async () => {
    mockedAlert.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const svc = new CostGrowthService(fakeRedis() as any);
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    await expect(feed(svc, CHAT, GROWING)).resolves.toBeUndefined();
  });
});

describe('текст алерта', () => {
  it('цепочка токенов и долларов, множитель, расклад последнего хода; HTML экранирован', () => {
    const run = GROWING.map((t) => ({ tokens: t, usd: t / 3600, note: 'reported=$6.21 <x>' }));
    const text = formatCostGrowthAlert({ kind: 'tg', configId: 'c', chatId: '1', payerUserId: 'o', botName: 'A<b>' }, run, 41300);
    expect(text).toContain('📈 <b>Стоимость растёт с каждым ответом</b>');
    expect(text).toContain('420 → 610 → 980 → 1');
    expect(text).toContain('$0.12 → $0.17 → $0.27 → $0.46 → $0.81');
    expect(text).toContain('×6,9');
    expect(text).toContain('A&lt;b&gt;');
    expect(text).toContain('reported=$6.21 &lt;x&gt;');
  });
  it('без остатка — строки «Остаток» нет', () => {
    const run = GROWING.map((t) => ({ tokens: t, usd: t / 3600 }));
    expect(formatCostGrowthAlert(CHAT, run)).not.toContain('Остаток');
  });
});
