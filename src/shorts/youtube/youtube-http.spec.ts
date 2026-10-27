import * as http from 'http';
import { AddressInfo } from 'net';
import { axiosHttp, clip, googleReason, googleReasonCode } from './youtube-http';

describe('googleReason', () => {
  it('ошибка API: reason и message', () => {
    expect(googleReason({
      status: 403, headers: {},
      data: { error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } },
    })).toBe('HTTP 403 quotaExceeded: The request cannot be completed because you have exceeded your quota.');
  });

  it('ошибка OAuth: error и error_description', () => {
    expect(googleReason({ status: 400, headers: {}, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }))
      .toBe('HTTP 400 invalid_grant: Token has been expired or revoked.');
  });

  it('строковое тело (HTML с upload_id) не берётся; длинная причина — не длиннее 300 знаков', () => {
    expect(googleReason({ status: 404, headers: {}, data: '<html>/upload?upload_id=SECRET</html>' })).toBe('HTTP 404');
    expect(googleReason({ status: 400, headers: {}, data: { error: { message: 'x'.repeat(1000) } } })).toHaveLength(300);
  });
});

describe('googleReasonCode', () => {
  it('объект с errors[0].reason — код причины', () => {
    expect(googleReasonCode({ status: 403, headers: {}, data: { error: { errors: [{ reason: 'quotaExceeded' }] } } })).toBe('quotaExceeded');
  });

  it('строковое error, пустое тело, не-объект — null', () => {
    expect(googleReasonCode({ status: 400, headers: {}, data: { error: 'invalid_grant', error_description: 'x' } })).toBeNull();
    expect(googleReasonCode({ status: 403, headers: {}, data: {} })).toBeNull();
    expect(googleReasonCode({ status: 403, headers: {}, data: undefined })).toBeNull();
    expect(googleReasonCode({ status: 404, headers: {}, data: '<html>/upload?upload_id=SECRET</html>' })).toBeNull();
  });
});

describe('clip', () => {
  it('не режет суррогатную пару', () => {
    const smile = String.fromCodePoint(0x1f600);
    expect(clip(`ab${smile}`, 3)).toBe('ab');
    expect(clip(`ab${smile}`, 4)).toBe(`ab${smile}`);
    expect(clip('abc', 10)).toBe('abc');
  });
});

describe('axiosHttp против локального сервера', () => {
  let server: http.Server;
  let base: string;
  const routes: Record<string, (q: http.IncomingMessage, s: http.ServerResponse) => void> = {
    '/teapot': (_q, s) => {
      s.writeHead(418, { 'content-type': 'application/json' });
      s.end('{"error":{"message":"teapot"}}');
    },
    '/boom': (_q, s) => {
      s.writeHead(503, { 'content-type': 'text/html' });
      s.end('<html>upload_id=SECRET</html>');
    },
    '/resume': (_q, s) => {
      s.writeHead(308, { Location: '/elsewhere', Range: 'bytes=0-9' });
      s.end();
    },
    '/elsewhere': (_q, s) => {
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end('{"followed":true}');
    },
    // Не читает тело и не отвечает: запрос держится, пока клиент не бросит его по сроку.
    '/hang': () => undefined,
    // Пишет пробел каждые 50 мс: сокет активен, срок простоя не наступает — спасает только общий срок.
    '/trickle': (_q, s) => {
      s.writeHead(200, { 'content-type': 'application/json' });
      const t = setInterval(() => s.write(' '), 50);
      s.on('close', () => clearInterval(t));
    },
    '/reset': (q) => q.socket.destroy(),
  };

  beforeAll(async () => {
    server = http.createServer((q, s) => {
      const route = routes[String(q.url).split('?')[0]];
      if (route) return route(q, s);
      s.writeHead(404);
      s.end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    (server as any).closeAllConnections?.();
    await new Promise((ok) => server.close(ok));
  });

  it('4xx и 5xx — ответ, а не исключение; JSON разобран', async () => {
    const a = await axiosHttp({ method: 'GET', url: `${base}/teapot`, timeout: 2000 });
    expect(a.status).toBe(418);
    expect(a.data).toEqual({ error: { message: 'teapot' } });
    expect((await axiosHttp({ method: 'GET', url: `${base}/boom`, timeout: 2000 })).status).toBe(503);
  });

  it('308 с Location — не переходит; имена заголовков в нижнем регистре', async () => {
    const r = await axiosHttp({ method: 'PUT', url: `${base}/resume`, data: Buffer.from('x'), timeout: 2000 });
    expect(r.status).toBe(308);
    expect(r.headers.location).toBe('/elsewhere');
    expect(r.headers.range).toBe('bytes=0-9');
  });

  it('сервер не принимает тело и молчит — отказ к сроку, в ошибке нет ни токена, ни config', async () => {
    const t0 = Date.now();
    const e = await axiosHttp({
      method: 'PUT', url: `${base}/hang`, data: Buffer.alloc(8 * 1024 * 1024),
      headers: { Authorization: 'Bearer secret-token' }, timeout: 300,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(String(e.message)).not.toContain('secret-token');
    expect(e.config).toBeUndefined();
  });

  it('сокет активен, а ответ не кончается — отказ к общему сроку с понятным текстом', async () => {
    const t0 = Date.now();
    const e = await axiosHttp({ method: 'GET', url: `${base}/trickle`, timeout: 300 }).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('общий срок 300 мс истёк');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('обрыв соединения — исключение без секретов формы', async () => {
    const e = await axiosHttp({
      method: 'POST', url: `${base}/reset`, data: 'client_secret=GOCSPX-x&refresh_token=rt-secret',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 2000,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e.config).toBeUndefined();
    expect(`${e.message} ${JSON.stringify(e)}`).not.toMatch(/GOCSPX|rt-secret/);
  });
});
