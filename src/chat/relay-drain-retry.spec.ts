import * as http from 'http';
import { AddressInfo } from 'net';
import { Readable } from 'stream';
import axios from 'axios';
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

  // Последний отказ отличает выкат (503 шлагбаума) от аварии: релей в цикле
  // падений (nginx 502) или лежит сам nginx (ECONNREFUSED).
  it('бюджет исчерпан после 503 и 502 → lastRefusal = 502', async () => {
    const make = jest.fn().mockRejectedValueOnce(httpErr(503)).mockRejectedValueOnce(httpErr(502));
    const err = await postRelayWithDrainRetry(make, { delaysMs: [1], sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(false);
    expect(err.lastRefusal).toBe(502);
  });

  it('бюджет исчерпан на одних ECONNREFUSED → lastRefusal = ECONNREFUSED', async () => {
    const make = jest.fn().mockRejectedValue(codeErr('ECONNREFUSED'));
    const err = await postRelayWithDrainRetry(make, { delaysMs: [1], sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(false);
    expect(err.lastRefusal).toBe('ECONNREFUSED');
  });

  it('перебит во время ожидания после 503 → lastRefusal = 503', async () => {
    let stop = false;
    const make = jest.fn().mockRejectedValue(httpErr(503));
    const err = await postRelayWithDrainRetry(make, {
      delaysMs: [30000], shouldStop: () => stop, sleep: async () => { stop = true; },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(true);
    expect(err.lastRefusal).toBe(503);
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
    expect(err.attempts).toBe(1);
    expect(steps).toBe(2);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('ход перебит во время неудачной попытки → superseded сразу, без onRetry и ожидания', async () => {
    let stop = false;
    const make = jest.fn(async () => { stop = true; throw httpErr(503); });
    const onRetry = jest.fn();
    const sleep = jest.fn(async () => {});
    const err = await postRelayWithDrainRetry(make, {
      delaysMs: [5, 5], shouldStop: () => stop, onRetry, sleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(true);
    expect(err.attempts).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('ход перебит во время последней попытки → superseded, а не «бюджет исчерпан»', async () => {
    let stop = false;
    const make = jest.fn(async () => { stop = true; throw httpErr(503); });
    const err = await postRelayWithDrainRetry(make, { delaysMs: [], shouldStop: () => stop, sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(true);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('тело отказа закрывается и на последней попытке', async () => {
    const destroy = jest.fn();
    const e = Object.assign(new Error('503'), { response: { status: 503, data: { destroy } } });
    const make = jest.fn().mockRejectedValue(e);
    const err = await postRelayWithDrainRetry(make, { delaysMs: [], sleep: noSleep }).catch((x) => x);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(false);
  });

  it('первая попытка не спрашивает shouldStop', async () => {
    const make = jest.fn().mockResolvedValue('ok');
    const shouldStop = jest.fn(() => true);
    await expect(postRelayWithDrainRetry(make, { shouldStop })).resolves.toBe('ok');
    expect(shouldStop).not.toHaveBeenCalled();
  });

  it('боевое расписание укладывается в ~2.5 минуты', () => {
    const total = RELAY_DRAIN_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(120_000);
    expect(total).toBeLessThanOrEqual(180_000);
  });
});

// Настоящий axios и настоящий HTTP: проверяем, что отказ с responseType: 'stream'
// распознаётся по response.status и повтор действительно уходит вторым запросом.
// axios здесь не замокан: automock выключен, в корневом __mocks__ его нет.
describe('postRelayWithDrainRetry поверх настоящего axios', () => {
  let server: http.Server;
  let url = '';
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      req.resume();
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('draining');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`;
  });

  afterAll(async () => {
    (server as any).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('503 с телом: повтор вторым запросом, затем RelayDrainingError(superseded=false)', async () => {
    const make = () => axios.post(url, 'x', { responseType: 'stream' });
    const err = await postRelayWithDrainRetry(make, { delaysMs: [0] }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(false);
    expect(err.attempts).toBe(2);
    expect(hits).toBe(2);
  });
});
