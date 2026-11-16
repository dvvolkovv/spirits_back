import { Readable } from 'stream';
import { postRelayWithDrainRetry, RelayDrainingError, isRelayDrainingError, RELAY_DRAIN_DELAYS_MS } from './relay-drain-retry';

const httpErr = (status: number) => {
  const data = Readable.from([]);
  return Object.assign(new Error(String(status)), { response: { status, data } });
};
const codeErr = (code: string) => Object.assign(new Error(code), { code });
const noSleep = async () => {};

describe('isRelayDrainingError', () => {
  it.each([[httpErr(502), true], [httpErr(503), true], [codeErr('ECONNREFUSED'), true],
    [httpErr(500), false], [httpErr(504), false], [codeErr('ECONNRESET'), false],
    [codeErr('ECONNABORTED'), false], [new Error('timeout of 300000ms exceeded'), false]])(
    '%s → %s', (err, expected) => expect(isRelayDrainingError(err)).toBe(expected));
});

describe('postRelayWithDrainRetry', () => {
  it('502, 503 и ECONNREFUSED повторяются по расписанию задержек, затем успех', async () => {
    const errs = [httpErr(503), httpErr(502), codeErr('ECONNREFUSED')];
    const make = jest.fn(async () => { const e = errs.shift(); if (e) throw e; return 'ok'; });
    const slept: number[] = [];
    const retries: [number, number][] = [];
    const r = await postRelayWithDrainRetry(make, {
      delaysMs: [3, 5, 7], sleep: async (ms) => { slept.push(ms); }, onRetry: (n, d) => retries.push([n, d]),
    });
    expect(r).toBe('ok');
    expect(make).toHaveBeenCalledTimes(4);
    expect(retries).toEqual([[1, 3], [2, 5], [3, 7]]);
    expect(slept).toEqual([3, 5, 7]);
  });

  it('задержка дробится на шаги не длиннее секунды', async () => {
    const make = jest.fn().mockRejectedValueOnce(httpErr(503)).mockResolvedValueOnce('ok');
    const slept: number[] = [];
    await postRelayWithDrainRetry(make, { delaysMs: [2500], sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([1000, 1000, 500]);
  });

  it.each([[httpErr(500)], [httpErr(504)], [codeErr('ECONNRESET')], [new Error('timeout of 1ms exceeded')]])(
    '%s бросается сразу, без повтора', async (err) => {
      const make = jest.fn().mockRejectedValue(err);
      await expect(postRelayWithDrainRetry(make, { delaysMs: [1, 1], sleep: noSleep })).rejects.toBe(err);
      expect(make).toHaveBeenCalledTimes(1);
    });

  it('фабрика зовётся на каждой попытке, тело отказа закрывается', async () => {
    const e1 = httpErr(503);
    const destroy = jest.spyOn(e1.response.data, 'destroy');
    const make = jest.fn().mockRejectedValueOnce(e1).mockResolvedValueOnce('ok');
    await postRelayWithDrainRetry(make, { delaysMs: [1], sleep: noSleep });
    expect(make).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalled();
  });

  it('бюджет исчерпан → RelayDrainingError(superseded=false)', async () => {
    const make = jest.fn().mockRejectedValue(httpErr(503));
    const err = await postRelayWithDrainRetry(make, { delaysMs: [1, 1], sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(false);
    expect(err.attempts).toBe(3);
    expect(make).toHaveBeenCalledTimes(3);
  });

  it('shouldStop во время ожидания → superseded не позже чем через секунду', async () => {
    let stop = false;
    let steps = 0;
    const make = jest.fn().mockRejectedValue(httpErr(503));
    const err = await postRelayWithDrainRetry(make, {
      delaysMs: [30000], shouldStop: () => stop,
      sleep: async () => { steps++; if (steps === 2) stop = true; },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(true);
    expect(steps).toBe(2);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('первая попытка не спрашивает shouldStop', async () => {
    const make = jest.fn().mockResolvedValue('ok');
    await expect(postRelayWithDrainRetry(make, { shouldStop: () => true })).resolves.toBe('ok');
  });

  it('боевое расписание укладывается в ~2.5 минуты', () => {
    const total = RELAY_DRAIN_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(120_000);
    expect(total).toBeLessThanOrEqual(180_000);
  });
});
