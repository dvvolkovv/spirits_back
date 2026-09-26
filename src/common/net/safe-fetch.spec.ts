import * as http from 'http';
import * as os from 'os';
import * as zlib from 'zlib';
import { AddressInfo } from 'net';
import { isBlockedAddress } from './ip-policy';
import {
  __setSafeFetchDepsForTests,
  assertPublicUrl,
  checkUrlSyntax,
  isUnsafeUrlError,
  ownStorageRoute,
  pinnedLookup,
  safeGet,
  UnsafeUrlError,
} from './safe-fetch';

/**
 * SSRF: сервер скачивает по чужой ссылке. Здесь проверяется сама защита —
 * разбор ссылки, DNS, пиннинг соединения, редиректы, лимиты.
 *
 * Сетевые кейсы гоняются против настоящего HTTP-сервера на 127.0.0.1. Чтобы
 * он играл роль «сервера в интернете», классификатор в этих тестах считает
 * публичным РОВНО 127.0.0.1 — всё остальное (127.0.0.2, 10/8, 169.254/16…)
 * остаётся запретным по настоящим правилам. Отдельные кейсы идут вообще без
 * подмен и доказывают, что с настоящим классификатором до сервера не
 * доходит ни одного запроса.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface TestServer {
  port: number;
  hits: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
  const hits: TestServer['hits'] = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url || '', headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    close: () => new Promise<void>((resolve) => {
      (server as any).closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Классификатор тестов: 127.0.0.1 — «интернет», остальное по правилам. */
const testIsBlocked = (ip: string) => ip !== '127.0.0.1' && isBlockedAddress(ip);

/** DNS тестов: *.test → адреса из таблицы, остальное — ENOTFOUND. */
function fakeResolver(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (host: string) => {
    calls.push(host);
    const list = table[host];
    if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return list.map((address) => ({ address, family: (address.includes(':') ? 6 : 4) as 4 | 6 }));
  };
  return { resolve, calls };
}

afterEach(() => {
  __setSafeFetchDepsForTests(null);
  jest.restoreAllMocks();
});

describe('checkUrlSyntax — проверка без сети', () => {
  it.each(['ftp://example.com/a', 'file:///etc/passwd', 'gopher://example.com/', 'data:text/plain,hi', 'javascript:alert(1)', 'dict://x:11211/'])(
    '%s — схема не http(s)', (u) => {
      expect(() => checkUrlSyntax(u, { allowHttp: true })).toThrow(UnsafeUrlError);
    },
  );

  it('http — только если разрешили', () => {
    expect(() => checkUrlSyntax('http://example.com/a.png')).toThrow(/https/);
    expect(checkUrlSyntax('http://example.com/a.png', { allowHttp: true }).hostname).toBe('example.com');
    expect(checkUrlSyntax('https://example.com/a.png').hostname).toBe('example.com');
  });

  it('логин:пароль в ссылке — только если разрешили', () => {
    expect(() => checkUrlSyntax('https://user:pass@example.com/')).toThrow(/логин/);
    expect(() => checkUrlSyntax('https://user@example.com/')).toThrow(/логин/);
    expect(checkUrlSyntax('https://user:pass@example.com/', { allowCredentials: true }).username).toBe('user');
  });

  it('порт: 80/443 можно, прочие — только с allowAnyPort', () => {
    expect(() => checkUrlSyntax('https://example.com:8443/')).toThrow(/порт/);
    expect(() => checkUrlSyntax('http://example.com:6379/', { allowHttp: true })).toThrow(/порт/);
    expect(checkUrlSyntax('https://example.com:443/').port).toBe('');
    expect(checkUrlSyntax('https://example.com:80/').port).toBe('80');
    expect(checkUrlSyntax('http://example.com:443/', { allowHttp: true }).port).toBe('443');
    expect(checkUrlSyntax('https://example.com:8443/', { allowAnyPort: true }).port).toBe('8443');
  });

  it.each([
    'http://localhost/', 'http://LOCALHOST:80/', 'http://localhost./', 'http://api.localhost/',
    'http://metadata.google.internal/', 'http://printer.local/', 'http://nas.LOCAL./',
  ])('%s — служебное имя', (u) => {
    expect(() => checkUrlSyntax(u, { allowHttp: true })).toThrow(/внутреннюю сеть/);
  });

  // WHATWG URL приводит числовые формы к dotted-quad ДО нашей проверки —
  // эти кейсы сторожат, что проверяется уже нормализованный адрес.
  it.each([
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://0x7f000001/',
    'http://017700000001/', 'http://0177.0.0.1/', 'http://0/', 'http://0.0.0.0/', 'http://10.1.2.3/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/', 'http://[64:ff9b::127.0.0.1]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
    'http://127.0.0.1./', 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
  ])('%s — внутренний IP-литерал', (u) => {
    expect(() => checkUrlSyntax(u, { allowHttp: true })).toThrow(/внутреннюю сеть/);
  });

  it('публичный IP-литерал проходит', () => {
    expect(checkUrlSyntax('https://8.8.8.8/').hostname).toBe('8.8.8.8');
    expect(checkUrlSyntax('https://[2606:4700:4700::1111]/').hostname).toBe('[2606:4700:4700::1111]');
  });

  it('мусор вместо ссылки — понятный отказ', () => {
    expect(() => checkUrlSyntax('не ссылка')).toThrow(/некорректный адрес/);
    expect(() => checkUrlSyntax('')).toThrow(/некорректный адрес/);
    expect(() => checkUrlSyntax('/static/x.png')).toThrow(/некорректный адрес/);
  });

  it('ошибка отличима от сетевой', () => {
    let err: any = null;
    try {
      checkUrlSyntax('http://127.0.0.1/', { allowHttp: true });
    } catch (e) {
      err = e;
    }
    expect(isUnsafeUrlError(err)).toBe(true);
    expect(err.code).toBe('UNSAFE_URL');
    expect(isUnsafeUrlError(new Error('ECONNREFUSED'))).toBe(false);
  });
});

describe('assertPublicUrl — DNS', () => {
  it('отдаёт проверенные адреса публичного имени', async () => {
    const dns = fakeResolver({ 'cdn.example.com': ['93.184.216.34', '2606:2800:220:1::1'] });
    __setSafeFetchDepsForTests({ resolve: dns.resolve });
    const t = await assertPublicUrl('https://CDN.Example.com./a.png');
    expect(t.hostname).toBe('cdn.example.com');
    expect(t.addresses.map((a) => a.address)).toEqual(['93.184.216.34', '2606:2800:220:1::1']);
    expect(dns.calls).toEqual(['cdn.example.com']);
  });

  it.each([
    [['127.0.0.1']],
    [['10.0.0.5']],
    [['169.254.169.254']],
    [['8.8.8.8', '192.168.1.10']], // хоть один внутренний — отказ
    [['::ffff:127.0.0.1']],
    [['2606:4700::1', 'fd00::1']],
    [['64:ff9b::a00:1']],
  ])('имя резолвится в %j — отказ', async (addrs) => {
    __setSafeFetchDepsForTests({ resolve: fakeResolver({ 'evil.example': addrs }).resolve });
    await expect(assertPublicUrl('https://evil.example/x')).rejects.toThrow(UnsafeUrlError);
  });

  it('несуществующее имя — сетевая ошибка, а не отказ безопасности', async () => {
    __setSafeFetchDepsForTests({ resolve: fakeResolver({}).resolve });
    const err = await assertPublicUrl('https://nope.example/').catch((e) => e);
    expect(isUnsafeUrlError(err)).toBe(false);
    expect(err.code).toBe('ENOTFOUND');
    expect(err.message).toMatch(/не найден/);
  });

  it('пустой ответ DNS — тоже «не найден»', async () => {
    __setSafeFetchDepsForTests({ resolve: async () => [] });
    await expect(assertPublicUrl('https://empty.example/')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('адрес собственного интерфейса запрещён, даже если он публичный', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ address: '212.113.106.202', family: 'IPv4', internal: false } as any],
    });
    __setSafeFetchDepsForTests({ resolve: fakeResolver({ 'hairpin.example': ['212.113.106.202'] }).resolve });
    await expect(assertPublicUrl('https://hairpin.example/')).rejects.toThrow(UnsafeUrlError);
    // и как литерал — тоже
    expect(() => checkUrlSyntax('https://212.113.106.202/')).toThrow(UnsafeUrlError);
  });

  it('SSRF_EXTRA_BLOCKED_CIDRS добавляет свои запреты', async () => {
    const prev = process.env.SSRF_EXTRA_BLOCKED_CIDRS;
    process.env.SSRF_EXTRA_BLOCKED_CIDRS = ' 92.53.64.0/24 , 2a01:4f8::/32';
    try {
      __setSafeFetchDepsForTests({ resolve: fakeResolver({ 'proxy.example': ['92.53.64.147'], 'v6.example': ['2a01:4f8::7'], 'ok.example': ['8.8.8.8'] }).resolve });
      await expect(assertPublicUrl('https://proxy.example/')).rejects.toThrow(UnsafeUrlError);
      await expect(assertPublicUrl('https://v6.example/')).rejects.toThrow(UnsafeUrlError);
      await expect(assertPublicUrl('https://ok.example/')).resolves.toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.SSRF_EXTRA_BLOCKED_CIDRS; else process.env.SSRF_EXTRA_BLOCKED_CIDRS = prev;
    }
  });
});

describe('pinnedLookup — соединение только на проверенные адреса', () => {
  const addrs = [{ address: '93.184.216.34', family: 4 as const }, { address: '2606:2800:220:1::1', family: 6 as const }];

  it('одиночный ответ — первый проверенный адрес', (done) => {
    pinnedLookup('cdn.example.com', addrs)('cdn.example.com', {}, (err: any, address: string, family: number) => {
      expect(err).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
      done();
    });
  });

  it('all: true (happy eyeballs node 20+) — все проверенные', (done) => {
    pinnedLookup('cdn.example.com', addrs)('cdn.example.com', { all: true }, (err: any, list: any[]) => {
      expect(err).toBeNull();
      expect(list).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
      done();
    });
  });

  it('фильтр по семейству', (done) => {
    pinnedLookup('cdn.example.com', addrs)('cdn.example.com', { family: 6 }, (err: any, address: string) => {
      expect(address).toBe('2606:2800:220:1::1');
      done();
    });
  });

  it('чужое имя — отказ, в DNS не ходит', (done) => {
    pinnedLookup('cdn.example.com', addrs)('evil.example', {}, (err: any) => {
      expect(isUnsafeUrlError(err)).toBe(true);
      done();
    });
  });
});

describe('safeGet против живого сервера', () => {
  let srv: TestServer;
  afterEach(async () => { await srv?.close(); });

  function useTestDns(extra: Record<string, string[]> = {}) {
    const dns = fakeResolver({ 'public.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'], 'internal.test': ['10.0.0.1'], ...extra });
    __setSafeFetchDepsForTests({ resolve: dns.resolve, isBlocked: testIsBlocked });
    return dns;
  }

  it('скачивает байты; Host — исходное имя, соединение — на проверенный адрес', async () => {
    srv = await startServer((req, res) => { res.setHeader('Content-Type', 'image/png'); res.end('png-bytes'); });
    useTestDns();
    const r = await safeGet(`http://public.test:${srv.port}/a.png`, { allowHttp: true, allowAnyPort: true, maxBytes: 1000, timeoutMs: 3000 });
    expect(Buffer.isBuffer(r.data)).toBe(true);
    expect(r.data.toString()).toBe('png-bytes');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.finalUrl).toBe(`http://public.test:${srv.port}/a.png`);
    expect(srv.hits[0].headers.host).toBe(`public.test:${srv.port}`);
  });

  it('text — строка без BOM', async () => {
    srv = await startServer((req, res) => res.end('﻿BEGIN:VCALENDAR'));
    useTestDns();
    const r = await safeGet(`http://public.test:${srv.port}/cal.ics`, { allowHttp: true, allowAnyPort: true, maxBytes: 1000, timeoutMs: 3000, responseType: 'text' });
    expect(r.data).toBe('BEGIN:VCALENDAR');
  });

  it('DNS rebinding: второй ответ DNS (внутренний) не используется — соединение пиннится', async () => {
    srv = await startServer((req, res) => res.end('ok'));
    let n = 0;
    const calls: string[] = [];
    __setSafeFetchDepsForTests({
      isBlocked: testIsBlocked,
      resolve: async (host) => {
        calls.push(host);
        n++;
        // Первый ответ «публичный», все следующие — внутренние. Если бы клиент
        // резолвил сам, он ушёл бы на 10.0.0.1 и не достучался.
        return [{ address: n === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }];
      },
    });
    const r = await safeGet(`http://rebind.test:${srv.port}/`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000 });
    expect(r.data.toString()).toBe('ok');
    expect(calls).toEqual(['rebind.test']);
    expect(srv.hits).toHaveLength(1);
  });

  it('системный DNS не участвует: имя, известное только проверке, всё равно соединяется', async () => {
    srv = await startServer((req, res) => res.end('pinned'));
    __setSafeFetchDepsForTests({ isBlocked: testIsBlocked, resolve: fakeResolver({ 'only-in-check.invalid': ['127.0.0.1'] }).resolve });
    const r = await safeGet(`http://only-in-check.invalid:${srv.port}/`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000 });
    expect(r.data.toString()).toBe('pinned');
  });

  it('относительный редирект проходит, finalUrl — последний шаг', async () => {
    srv = await startServer((req, res) => {
      if (req.url === '/start') { res.statusCode = 302; res.setHeader('Location', '/img/final.png'); return res.end(); }
      res.end('final');
    });
    useTestDns();
    const r = await safeGet(`http://public.test:${srv.port}/start`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000 });
    expect(r.data.toString()).toBe('final');
    expect(r.finalUrl).toBe(`http://public.test:${srv.port}/img/final.png`);
    expect(srv.hits.map((h) => h.url)).toEqual(['/start', '/img/final.png']);
  });

  it.each([
    ['внутренний IP-литерал', (port: number) => `http://127.0.0.2:${port}/secret`],
    ['метаданные облака', () => 'http://169.254.169.254/latest/meta-data/'],
    ['имя с внутренним адресом', (port: number) => `http://internal.test:${port}/secret`],
    ['localhost (резолвится в сам тестовый сервер)', (port: number) => `http://localhost:${port}/secret`],
    ['числовая форма 127.0.0.2', (port: number) => `http://2130706434:${port}/secret`],
    ['схема file:', () => 'file:///etc/passwd'],
    ['схема gopher:', () => 'gopher://public.test:70/_x'],
  ])('редирект на %s — отказ, до цели запрос не доходит', async (_name, target) => {
    srv = await startServer((req, res) => {
      if (req.url === '/start') { res.statusCode = 302; res.setHeader('Location', target(srv.port)); return res.end(); }
      res.end('SECRET');
    });
    useTestDns();
    const err = await safeGet(`http://public.test:${srv.port}/start`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000 }).catch((e) => e);
    expect(isUnsafeUrlError(err)).toBe(true);
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(srv.hits.map((h) => h.url)).toEqual(['/start']);
  });

  it('http без allowHttp — отказ до соединения (так же проверяется и каждый редирект)', async () => {
    // Каждый шаг, включая редиректы, проходит один и тот же prepareHop с той же
    // политикой, поэтому даунгрейд https → http по Location без allowHttp
    // отбивается ровно этой проверкой.
    srv = await startServer((req, res) => res.end('x'));
    useTestDns();
    await expect(safeGet(`http://public.test:${srv.port}/`, { allowAnyPort: true, maxBytes: 100, timeoutMs: 3000 })).rejects.toThrow(/https/);
    expect(srv.hits).toHaveLength(0);
  });

  it('цепочка длиннее maxRedirects — ошибка', async () => {
    srv = await startServer((req, res) => { res.statusCode = 302; res.setHeader('Location', '/loop'); res.end(); });
    useTestDns();
    await expect(
      safeGet(`http://public.test:${srv.port}/loop`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000 }),
    ).rejects.toThrow(/перенаправлений/);
    expect(srv.hits).toHaveLength(4); // первый запрос + 3 редиректа
  });

  it('заголовки вызывающего не уходят на чужой origin после редиректа', async () => {
    srv = await startServer((req, res) => {
      if (req.url === '/start') { res.statusCode = 302; res.setHeader('Location', `http://other.test:${srv.port}/next`); return res.end(); }
      res.end('ok');
    });
    useTestDns();
    await safeGet(`http://public.test:${srv.port}/start`, {
      allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000, headers: { 'X-Secret': 's3cr3t' },
    });
    expect(srv.hits[0].headers['x-secret']).toBe('s3cr3t');
    expect(srv.hits[1].headers['x-secret']).toBeUndefined();
    expect(srv.hits[1].headers.host).toBe(`other.test:${srv.port}`);
  });

  it('не-2xx — ошибка с кодом ответа; validateStatus позволяет разобрать самому', async () => {
    srv = await startServer((req, res) => { res.statusCode = 404; res.end('nope'); });
    useTestDns();
    const err = await safeGet(`http://public.test:${srv.port}/x`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000 }).catch((e) => e);
    expect(err.response.status).toBe(404);
    expect(isUnsafeUrlError(err)).toBe(false);
    const ok = await safeGet(`http://public.test:${srv.port}/x`, {
      allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000, validateStatus: () => true,
    });
    expect(ok.status).toBe(404);
  });

  it('тело больше maxBytes по Content-Length — отказ до чтения', async () => {
    srv = await startServer((req, res) => { res.setHeader('Content-Length', '5000'); res.end(Buffer.alloc(5000)); });
    useTestDns();
    await expect(
      safeGet(`http://public.test:${srv.port}/big`, { allowHttp: true, allowAnyPort: true, maxBytes: 1000, timeoutMs: 3000 }),
    ).rejects.toMatchObject({ code: 'ERR_TOO_LARGE' });
  });

  it('тело больше maxBytes без Content-Length (chunked) — обрыв на лимите', async () => {
    srv = await startServer((req, res) => {
      res.write(Buffer.alloc(800));
      res.write(Buffer.alloc(800));
      res.end(Buffer.alloc(800));
    });
    useTestDns();
    await expect(
      safeGet(`http://public.test:${srv.port}/chunked`, { allowHttp: true, allowAnyPort: true, maxBytes: 1000, timeoutMs: 3000 }),
    ).rejects.toMatchObject({ code: 'ERR_TOO_LARGE' });
  });

  it('gzip-бомба: лимит считается по распакованному', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(1024 * 1024)); // ~1 КБ сжатого, 1 МБ распакованного
    srv = await startServer((req, res) => { res.setHeader('Content-Encoding', 'gzip'); res.end(bomb); });
    useTestDns();
    await expect(
      safeGet(`http://public.test:${srv.port}/bomb`, { allowHttp: true, allowAnyPort: true, maxBytes: 64 * 1024, timeoutMs: 3000 }),
    ).rejects.toMatchObject({ code: 'ERR_TOO_LARGE' });
  });

  it('сервер молчит — отказ по сроку', async () => {
    srv = await startServer(() => { /* не отвечаем */ });
    useTestDns();
    const t0 = Date.now();
    await expect(
      safeGet(`http://public.test:${srv.port}/hang`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('медленная капельница тела — срок общий, а не на тишину сокета', async () => {
    srv = await startServer((req, res) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.flushHeaders();
      const t = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(t));
    });
    useTestDns();
    const t0 = Date.now();
    await expect(
      safeGet(`http://public.test:${srv.port}/drip`, { allowHttp: true, allowAnyPort: true, maxBytes: 1_000_000, timeoutMs: 400 }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('HTTP_PROXY из окружения не уводит запрос мимо пиннинга', async () => {
    srv = await startServer((req, res) => res.end('direct'));
    useTestDns();
    const prev = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY };
    process.env.HTTP_PROXY = 'http://10.9.9.9:3128';
    process.env.http_proxy = 'http://10.9.9.9:3128';
    delete process.env.NO_PROXY;
    try {
      const r = await safeGet(`http://public.test:${srv.port}/`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 2000 });
      expect(r.data.toString()).toBe('direct');
    } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('stream: отдаёт поток и рвёт его на лимите', async () => {
    srv = await startServer((req, res) => {
      if (req.url === '/small') return res.end('stream-bytes');
      res.write(Buffer.alloc(600));
      res.end(Buffer.alloc(600));
    });
    useTestDns();
    const ok = await safeGet(`http://public.test:${srv.port}/small`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 3000, responseType: 'stream' });
    const chunks: Buffer[] = [];
    for await (const c of ok.data) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('stream-bytes');

    const big = await safeGet(`http://public.test:${srv.port}/big`, { allowHttp: true, allowAnyPort: true, maxBytes: 1000, timeoutMs: 3000, responseType: 'stream' });
    const err = await (async () => { for await (const _ of big.data) { /* читаем */ } })().catch((e) => e);
    expect(err?.code).toBe('ERR_TOO_LARGE');
  });
});

describe('safeGet с настоящим классификатором: до внутреннего сервера не доходит ни одного запроса', () => {
  let srv: TestServer;
  beforeEach(async () => { srv = await startServer((req, res) => res.end('SECRET')); });
  afterEach(async () => { await srv.close(); });

  it.each([
    (port: number) => `http://127.0.0.1:${port}/`,
    (port: number) => `http://localhost:${port}/`,
    (port: number) => `http://[::ffff:127.0.0.1]:${port}/`,
    (port: number) => `http://0x7f000001:${port}/`,
  ])('%s', async (mk) => {
    const err = await safeGet(mk(srv.port), { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 2000 }).catch((e) => e);
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(srv.hits).toHaveLength(0);
  });

  it('имя, которое резолвится в 127.0.0.1', async () => {
    __setSafeFetchDepsForTests({ resolve: fakeResolver({ 'looks-public.example': ['127.0.0.1'] }).resolve });
    const err = await safeGet(`http://looks-public.example:${srv.port}/`, { allowHttp: true, allowAnyPort: true, maxBytes: 100, timeoutMs: 2000 }).catch((e) => e);
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(srv.hits).toHaveLength(0);
  });
});

describe('своё хранилище: MINIO_PUBLIC_URL → внутренний MINIO_ENDPOINT', () => {
  let srv: TestServer;
  const saved = { pub: process.env.MINIO_PUBLIC_URL, end: process.env.MINIO_ENDPOINT };

  beforeEach(async () => {
    srv = await startServer((req, res) => { res.setHeader('Content-Type', 'image/png'); res.end('minio-object'); });
    process.env.MINIO_PUBLIC_URL = 'https://my.linkeon.io/smm-media/';
    process.env.MINIO_ENDPOINT = `http://127.0.0.1:${srv.port}`;
  });
  afterEach(async () => {
    await srv.close();
    if (saved.pub === undefined) delete process.env.MINIO_PUBLIC_URL; else process.env.MINIO_PUBLIC_URL = saved.pub;
    if (saved.end === undefined) delete process.env.MINIO_ENDPOINT; else process.env.MINIO_ENDPOINT = saved.end;
  });

  it('наш объект читается изнутри, анонимно, без query и без DNS', async () => {
    const resolve = jest.fn(async () => { throw new Error('DNS не должен вызываться'); });
    __setSafeFetchDepsForTests({ resolve });
    const r = await safeGet('https://my.linkeon.io/smm-media/linkeon-assets/images/a%20b.png?list-type=2', {
      maxBytes: 1000, timeoutMs: 3000, headers: { Authorization: 'Bearer leak' },
    });
    expect(r.data.toString()).toBe('minio-object');
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.finalUrl).toBe('https://my.linkeon.io/smm-media/linkeon-assets/images/a%20b.png?list-type=2');
    expect(srv.hits).toHaveLength(1);
    expect(srv.hits[0].url).toBe('/linkeon-assets/images/a%20b.png');
    expect(srv.hits[0].headers.authorization).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['выход ../ за префикс', 'https://my.linkeon.io/smm-media/../webhook/profile'],
    ['%2e%2e тоже сворачивается', 'https://my.linkeon.io/smm-media/%2e%2e/webhook/profile'],
    ['бакет без ключа (листинг)', 'https://my.linkeon.io/smm-media/linkeon-assets/'],
    ['служебные пути MinIO', 'https://my.linkeon.io/smm-media/minio/v2/metrics/cluster'],
    ['другой origin', 'http://my.linkeon.io/smm-media/linkeon-assets/a.png'],
    ['другой хост', 'https://evil.example/smm-media/linkeon-assets/a.png'],
    ['префикс без разделителя', 'https://my.linkeon.io/smm-mediax/linkeon-assets/a.png'],
    ['логин в ссылке', 'https://u:p@my.linkeon.io/smm-media/linkeon-assets/a.png'],
  ])('%s — не наше хранилище', (_name, u) => {
    expect(ownStorageRoute(new URL(u))).toBeNull();
  });

  it('без окружения переписывания нет', () => {
    delete process.env.MINIO_ENDPOINT;
    expect(ownStorageRoute(new URL('https://my.linkeon.io/smm-media/linkeon-assets/a.png'))).toBeNull();
  });

  it('не наше — идёт обычной проверкой (и в DNS)', async () => {
    const dns = fakeResolver({ 'my.linkeon.io': ['10.0.0.7'] });
    __setSafeFetchDepsForTests({ resolve: dns.resolve });
    const err = await safeGet('https://my.linkeon.io/smm-media/../webhook/profile', { maxBytes: 100, timeoutMs: 2000 }).catch((e) => e);
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(dns.calls).toEqual(['my.linkeon.io']);
    expect(srv.hits).toHaveLength(0);
  });
});
