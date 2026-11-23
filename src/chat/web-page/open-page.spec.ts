import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import { isBlockedAddress, parseCidr } from '../../common/net/ip-policy';
import { __setSafeFetchDepsForTests, safeGet, SafeGetOptions } from '../../common/net/safe-fetch';
import {
  normalizePageUrl,
  openPage,
  OpenPageDeps,
  OPEN_PAGE_DEFAULT_CHARS,
  OPEN_PAGE_FETCH_OPTIONS,
  OPEN_PAGE_MAX_CHARS,
  OPEN_PAGE_READ_BYTES,
  OWN_INFRA_CIDRS,
  PageRateLimiter,
} from './open-page';

/**
 * open_page против живого HTTP-сервера на 127.0.0.1 — тот же приём, что в
 * safe-fetch.spec.ts: DNS подменён, «интернетом» считается ровно 127.0.0.1.
 * Порт тестового сервера нестандартный, поэтому вызов safeGet обёрнут:
 * обёртка добавляет к НАСТОЯЩИМ опциям инструмента только allowAnyPort (и в
 * отдельных кейсах — короткие сроки и лимит). Запреты наших адресов при этом
 * идут из опций самого инструмента — их и проверяем.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
interface TestServer { port: number; hits: Array<{ url: string; headers: http.IncomingHttpHeaders }>; close(): Promise<void> }

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

const DNS: Record<string, string[]> = {
  'site.test': ['127.0.0.1'],
  'prod.test': ['212.113.106.202'],
  'relay.test': ['5.101.115.184'],
  'stand.test': ['85.192.61.231'],
  'node3.test': ['5.45.115.22'],
  'proxy.test': ['8.8.8.8', '92.53.64.147'],
  'lan.test': ['10.0.0.5'],
};

function useTestDns() {
  __setSafeFetchDepsForTests({
    isBlocked: (ip: string) => ip !== '127.0.0.1' && isBlockedAddress(ip),
    resolve: async (host: string) => {
      const list = DNS[host];
      if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: (address.includes(':') ? 6 : 4) as 4 | 6 }));
    },
  });
}

function deps(over: Partial<SafeGetOptions> = {}, extra: Partial<OpenPageDeps> = {}): OpenPageDeps {
  return {
    limiter: new PageRateLimiter(1000, 60_000),
    get: ((url: string, opts: any) => safeGet(url, { ...opts, allowAnyPort: true, ...over })) as any,
    ...extra,
  };
}

const html = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const serve = (contentType: string | null, body: string | Buffer, status = 200): Handler => (req, res) => {
  res.statusCode = status;
  if (contentType) res.setHeader('Content-Type', contentType);
  res.end(body);
};

/**
 * Страховка: этот файл не выпускает ни одного соединения за пределы
 * 127.0.0.0/8. В кейсах ниже есть адреса наших настоящих серверов; если
 * запрет сломан, соединение оборвётся здесь, тест покраснеет, а наружу
 * (на прод, релей, стенд) не уйдёт ни байта.
 */
const outbound: string[] = [];
const isLoopback = (ip: string) => ip.startsWith('127.') || ip === '::1' || ip.startsWith('::ffff:127.');
function guardOutbound() {
  const orig = net.Socket.prototype.connect;
  jest.spyOn(net.Socket.prototype as any, 'connect').mockImplementation(function (this: any, ...args: any[]) {
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (o && typeof o === 'object') {
      if (typeof o.host === 'string' && net.isIP(o.host) && !isLoopback(o.host)) {
        outbound.push(o.host);
        throw new Error('тест: соединение наружу запрещено');
      }
      if (typeof o.lookup === 'function') {
        const lookup = o.lookup;
        o.lookup = (h: string, opts: any, cb: any) => lookup(h, opts, (err: any, a: any, f: any) => {
          if (err) return cb(err);
          const list: string[] = Array.isArray(a) ? a.map((x: any) => x.address) : [a];
          const bad = list.filter((ip) => !isLoopback(ip));
          if (bad.length) {
            outbound.push(...bad);
            return cb(new Error('тест: соединение наружу запрещено'));
          }
          cb(null, a, f);
        });
      }
    }
    return (orig as any).apply(this, args);
  });
}

let srv: TestServer | undefined;
beforeEach(() => {
  useTestDns();
  guardOutbound();
  outbound.length = 0;
});
afterEach(async () => {
  __setSafeFetchDepsForTests(null);
  jest.restoreAllMocks();
  await srv?.close();
  srv = undefined;
  expect(outbound).toEqual([]);
});

describe('опции скачивания', () => {
  it('http и https, только стандартные порты, до 5 редиректов, 15 с; читается до 3 МБ, больше 10 МБ — отказ; наши адреса закрыты', () => {
    expect(OPEN_PAGE_FETCH_OPTIONS).toMatchObject({
      allowHttp: true,
      maxRedirects: 5,
      timeoutMs: 15_000,
      maxBytes: 10 * 1024 * 1024,
      responseType: 'stream',
    });
    expect(OPEN_PAGE_READ_BYTES).toBe(3 * 1024 * 1024);
    expect((OPEN_PAGE_FETCH_OPTIONS as any).allowAnyPort).toBeFalsy();
    expect((OPEN_PAGE_FETCH_OPTIONS as any).allowCredentials).toBeFalsy();
    expect(OPEN_PAGE_FETCH_OPTIONS.extraBlockedCidrs).toBe(OWN_INFRA_CIDRS);
  });

  it('список наших адресов полный и весь разбирается', () => {
    for (const ip of ['212.113.106.202', '5.101.115.184', '85.192.61.231', '5.45.115.22', '92.53.64.147']) {
      expect(OWN_INFRA_CIDRS.some((c) => c.split('/')[0] === ip)).toBe(true);
    }
    for (const c of OWN_INFRA_CIDRS) expect(parseCidr(c)).not.toBeNull();
  });
});

describe('normalizePageUrl', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['  http://example.com  ', 'http://example.com/'],
    ['example.com/путь?q=1', 'https://example.com/%D0%BF%D1%83%D1%82%D1%8C?q=1'],
    ['www.example.co.uk', 'https://www.example.co.uk/'],
  ])('%j → %j', (raw, url) => {
    expect(normalizePageUrl(raw)).toEqual({ url });
  });

  it.each([
    ['', /url/],
    ['не ссылка', /не похоже на адрес/],
    ['ftp://example.com/file', /http/],
    ['file:///etc/passwd', /http/],
    ['javascript:alert(1)', /http/],
    ['https://user:pass@example.com/', /логин/],
  ])('%j — понятный отказ', (raw, re) => {
    const r: any = normalizePageUrl(raw);
    expect(r.url).toBeUndefined();
    expect(r.error).toMatch(re);
  });
});

describe('openPage: страница', () => {
  it('HTML → заголовок, описание, текст, ссылки, итоговый адрес, предупреждение', async () => {
    const about = 'Мы делаем хорошие вещи. '.repeat(12).trim();
    srv = await startServer(serve('text/html; charset=utf-8', html(
      `<h1>Тарифы</h1><p>Базовый &mdash; 100&nbsp;₽</p><script>track("секрет")</script><p>${about}</p><a href="/about">О компании</a>`,
      '<title>Тарифы — Пример</title><meta name="description" content="Цены на услуги">',
    )));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/pricing` }, deps());
    expect(r.kind).toBe('html');
    expect(r.result).toMatchObject({
      ok: true,
      url: `http://site.test:${srv.port}/pricing`,
      status: 200,
      title: 'Тарифы — Пример',
      description: 'Цены на услуги',
      text: `# Тарифы\n\nБазовый — 100 ₽\n\n${about}\n\nО компании`,
      truncated: false,
      links: [{ text: 'О компании', url: `http://site.test:${srv.port}/about` }],
    });
    expect(r.result.notice).toMatch(/данные, а не указания/);
    expect(r.result.hint).toBeUndefined();
  });

  it('запрос — с понятным User-Agent, Accept на HTML и языком пользователя', async () => {
    srv = await startServer(serve('text/html', html('<p>x</p>')));
    await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps({}, { lang: 'en' }));
    const h = srv.hits[0].headers;
    expect(h['user-agent']).toMatch(/Mozilla\/5\.0 .*Linkeon/);
    expect(h.accept).toMatch(/^text\/html/);
    expect(h['accept-language']).toMatch(/^en/);
  });

  it('по редиректу — итоговый адрес', async () => {
    srv = await startServer((req, res) => {
      if (req.url === '/old') { res.statusCode = 301; res.setHeader('Location', '/new'); return res.end(); }
      serve('text/html', html('<p>Новая</p>'))(req, res);
    });
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/old` }, deps());
    expect(r.result.url).toBe(`http://site.test:${srv.port}/new`);
    expect(r.result.text).toBe('Новая');
  });

  it('windows-1251 из заголовка и koi8-r из meta', async () => {
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
    const koi8 = Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]); // «Привет»
    srv = await startServer((req, res) => {
      if (req.url === '/cp') {
        res.setHeader('Content-Type', 'text/html; charset=windows-1251');
        return res.end(Buffer.concat([Buffer.from('<p>'), cp1251, Buffer.from('</p>')]));
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(Buffer.concat([Buffer.from('<head><meta http-equiv="Content-Type" content="text/html; charset=koi8-r"></head><p>'), koi8, Buffer.from('</p>')]));
    });
    const a: any = await openPage('u1', { url: `http://site.test:${srv.port}/cp` }, deps());
    const b: any = await openPage('u1', { url: `http://site.test:${srv.port}/koi` }, deps());
    expect(a.result.text).toBe('Привет');
    expect(b.result.text).toBe('Привет');
  });

  it('обрезка: по умолчанию 20000 символов, max_chars в пределах 1000…40000', async () => {
    const long = Array.from({ length: 6000 }, (_, i) => `слово${i}`).join(' '); // ~60 000 символов
    srv = await startServer(serve('text/plain; charset=utf-8', long));
    const url = `http://site.test:${srv.port}/long.txt`;
    const def: any = await openPage('u1', { url }, deps());
    expect(def.result.truncated).toBe(true);
    expect(def.result.text.length).toBeLessThanOrEqual(OPEN_PAGE_DEFAULT_CHARS);
    expect(def.result.text.length).toBeGreaterThan(OPEN_PAGE_DEFAULT_CHARS * 0.9);
    const big: any = await openPage('u1', { url, max_chars: 1_000_000 }, deps());
    expect(big.result.text.length).toBeLessThanOrEqual(OPEN_PAGE_MAX_CHARS);
    expect(big.result.text.length).toBeGreaterThan(OPEN_PAGE_MAX_CHARS * 0.9);
    const small: any = await openPage('u1', { url, max_chars: 10 }, deps());
    expect(small.result.text.length).toBeLessThanOrEqual(1000);
    expect(small.result.text.length).toBeGreaterThan(900);
    const junk: any = await openPage('u1', { url, max_chars: 'много' }, deps());
    expect(junk.result.text.length).toBe(def.result.text.length);
  });

  it.each([
    ['text/plain; charset=utf-8', 'Просто текст', 'text'],
    ['text/markdown', '# Заголовок\n\nТекст', 'text'],
    ['text/csv', 'имя,цена\nчай,100', 'text'],
    ['application/json', '{"a":1}', 'json'],
    ['application/ld+json', '{"@type":"Thing"}', 'json'],
    ['application/xml', '<a>1</a>', 'xml'],
    ['application/rss+xml', '<rss><channel><title>Лента</title></channel></rss>', 'xml'],
  ])('%s — текст как есть', async (ct, body, kind) => {
    srv = await startServer(serve(ct, body));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/x` }, deps());
    expect(r.kind).toBe(kind);
    expect(r.result).toMatchObject({ ok: true, text: body, title: '', links: [] });
  });

  it('application/xhtml+xml разбирается как HTML', async () => {
    srv = await startServer(serve('application/xhtml+xml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>X</title></head><body><p>Тело</p></body></html>'));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps());
    expect(r.kind).toBe('html');
    expect(r.result).toMatchObject({ title: 'X', text: 'Тело' });
  });

  it('без Content-Type: похоже на HTML — разбирается как HTML', async () => {
    srv = await startServer(serve(null, '<!DOCTYPE html><html><body><p>Без заголовка</p></body></html>'));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps());
    expect(r.kind).toBe('html');
    expect(r.result.text).toBe('Без заголовка');
  });

  it('страница, которую собирает скрипт, — подсказка попросить скриншот или текст', async () => {
    srv = await startServer(serve('text/html', html('<div id="root"></div><script src="/app.js"></script><noscript>Включите JavaScript</noscript>', '<title>Приложение</title>')));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps());
    expect(r.result.ok).toBe(true);
    expect(r.result.hint).toMatch(/скрипт/);
    expect(r.result.hint).toMatch(/скриншот/);
  });

  it('короткая страница без скриптов — без подсказки', async () => {
    srv = await startServer(serve('text/html', html('<p>Коротко.</p>')));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps());
    expect(r.result.hint).toBeUndefined();
  });

  it('страница больше 3 МБ (без Content-Length) — читается начало, ответ с truncated', async () => {
    const piece = 'абвгд '.repeat(10_000); // 110 000 байт
    srv = await startServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      for (let i = 0; i < 40; i++) res.write(piece); // ~4,4 МБ
      res.end();
    });
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps());
    expect(r.result.ok).toBe(true);
    expect(r.result.truncated).toBe(true);
    expect(r.result.text.startsWith('абвгд абвгд')).toBe(true);
  });
});

describe('openPage: не страница и ошибки', () => {
  it.each([
    ['application/pdf', '%PDF-1.7'],
    ['image/png', '\x89PNG'],
    ['image/svg+xml', '<svg/>'],
    ['application/zip', 'PK'],
    ['application/octet-stream', 'bytes'],
  ])('%s — ok:false с подсказкой прислать файл в чат', async (ct, body) => {
    srv = await startServer(serve(ct, body));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/f` }, deps());
    expect(r.kind).toBe('not_page');
    expect(r.result.ok).toBe(false);
    expect(r.result.error).toContain(ct);
    expect(r.result.error).toMatch(/прислать файл в чат/);
  });

  it('без Content-Type и с двоичными байтами — не страница', async () => {
    srv = await startServer(serve(null, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01])));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps());
    expect(r.kind).toBe('not_page');
  });

  it.each([
    [404, 'http_4xx', /404/],
    [403, 'http_4xx', /403/],
    [500, 'http_5xx', /500/],
    [503, 'http_5xx', /503/],
  ])('статус %d — ok:false', async (status, kind, re) => {
    srv = await startServer(serve('text/html', html('<p>ошибка</p>'), status));
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps());
    expect(r.kind).toBe(kind);
    expect(r.result).toEqual({ ok: false, error: expect.stringMatching(re) });
  });

  it.each([
    ['прод', 'http://prod.test/'],
    ['релей', 'https://relay.test/'],
    ['тестовый стенд', 'http://stand.test/'],
    ['node-3', 'https://node3.test/'],
    ['прокси Selectel среди адресов имени', 'https://proxy.test/'],
    ['IP-литерал прода', 'http://212.113.106.202/'],
    ['IP-литерал прокси', 'https://92.53.64.147/webhook/profile'],
    ['IPv4-mapped литерал релея', 'http://[::ffff:5.101.115.184]/'],
    ['внутренняя сеть', 'http://lan.test/'],
    ['внутренний литерал', 'http://10.1.2.3/'],
    ['localhost', 'http://localhost/'],
  ])('%s — отказ без подробностей', async (_name, url) => {
    const r: any = await openPage('u1', { url }, deps());
    expect(r.kind).toBe('unsafe');
    expect(r.result.ok).toBe(false);
    expect(r.result.error).not.toMatch(/\d+\.\d+\.\d+\.\d+|::ffff|\.test|localhost/);
  });

  it.each([
    ['имя релея', () => 'http://relay.test/secret'],
    ['IP-литерал прода', () => 'http://212.113.106.202/'],
    ['имя стенда с портом', (port: number) => `http://stand.test:${port}/`],
  ])('редирект на наш адрес (%s) — отказ, дальше первого шага запрос не идёт', async (_n, target) => {
    srv = await startServer((req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', target(srv!.port));
      res.end();
    });
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/start` }, deps());
    expect(r.kind).toBe('unsafe');
    expect(srv.hits.map((h) => h.url)).toEqual(['/start']);
  });

  it('нестандартный порт без обёртки теста — отказ', async () => {
    const r: any = await openPage('u1', { url: 'http://site.test:8080/' }, { limiter: new PageRateLimiter(10, 1000) });
    expect(r.kind).toBe('unsafe');
  });

  it('домен не найден', async () => {
    const r: any = await openPage('u1', { url: 'https://no-such-host.test/' }, deps());
    expect(r.kind).toBe('dns');
    expect(r.result.error).toMatch(/не найден/);
  });

  it('никто не слушает — не удалось соединиться', async () => {
    const tmp = await startServer(() => undefined);
    const port = tmp.port;
    await tmp.close();
    const r: any = await openPage('u1', { url: `http://site.test:${port}/` }, deps());
    expect(r.kind).toBe('network');
    expect(r.result.error).toMatch(/соединиться/);
  });

  it('сервер молчит — не ответил вовремя', async () => {
    srv = await startServer(() => { /* не отвечаем */ });
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps({ timeoutMs: 300 }));
    expect(r.kind).toBe('timeout');
    expect(r.result.error).toMatch(/вовремя/);
  });

  it('тело капает слишком долго — тоже «не ответил вовремя»', async () => {
    srv = await startServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.flushHeaders();
      const t = setInterval(() => res.write('<p>x</p>'), 50);
      res.on('close', () => clearInterval(t));
    });
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps({ timeoutMs: 400 }));
    expect(r.kind).toBe('timeout');
  });

  it('объявленный размер больше лимита — «слишком большая»', async () => {
    srv = await startServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Length', '5000');
      res.end(Buffer.alloc(5000, 0x61));
    });
    const r: any = await openPage('u1', { url: `http://site.test:${srv.port}/` }, deps({ maxBytes: 1000 }));
    expect(r.kind).toBe('too_large');
    expect(r.result.error).toMatch(/слишком большая/);
  });

  it('без url и с мусором — bad_input, в сеть не ходит и лимит не тратит', async () => {
    const limiter = new PageRateLimiter(1, 60_000);
    const a: any = await openPage('u1', {}, { limiter });
    const b: any = await openPage('u1', { url: 'ftp://example.com/' }, { limiter });
    expect(a.kind).toBe('bad_input');
    expect(b.kind).toBe('bad_input');
    expect(limiter.take('u1')).toBe(true);
  });
});

describe('ограничение частоты', () => {
  it('PageRateLimiter: N за окно на пользователя, потом снова можно', () => {
    let now = 1_000_000;
    const l = new PageRateLimiter(3, 10_000, () => now);
    expect([l.take('a'), l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, true, false]);
    expect(l.take('b')).toBe(true);
    now += 10_001;
    expect(l.take('a')).toBe(true);
  });

  it('openPage: сверх лимита — ok:false «подожди», запрос не уходит', async () => {
    srv = await startServer(serve('text/html', html('<p>x</p>')));
    const d = deps({}, { limiter: new PageRateLimiter(2, 60_000) });
    const url = `http://site.test:${srv.port}/`;
    await openPage('u1', { url }, d);
    await openPage('u1', { url }, d);
    const third: any = await openPage('u1', { url }, d);
    expect(third.kind).toBe('rate_limited');
    expect(third.result).toEqual({ ok: false, error: expect.stringMatching(/подожди/) });
    expect(srv.hits).toHaveLength(2);
    const other: any = await openPage('u2', { url }, d);
    expect(other.result.ok).toBe(true);
  });

  it('по умолчанию — 30 страниц за 10 минут', () => {
    let now = 0;
    const l = new PageRateLimiter(undefined, undefined, () => now);
    for (let i = 0; i < 30; i++) expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(false);
    now += 10 * 60_000 + 1;
    expect(l.take('a')).toBe(true);
  });
});
