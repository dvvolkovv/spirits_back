import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { __setSafeFetchDepsForTests, UnsafeUrlError } from './safe-fetch';
import { assertFetchableMedia, fetchMediaBytes, ownStaticPath, toAbsoluteUrl } from './own-media';

/**
 * Свои медиа читаются в обход HTTP: /static/ — с диска, наш MinIO — изнутри.
 * Чужие ссылки — только через проверку SSRF.
 */

const ENV_KEYS = ['PUBLIC_DIR', 'BACKEND_URL', 'PUBLIC_BASE_URL', 'MINIO_PUBLIC_URL', 'MINIO_ENDPOINT'] as const;
const savedEnv: Record<string, string | undefined> = {};
let publicRoot: string;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'own-media-'));
  fs.mkdirSync(path.join(publicRoot, 'generated'));
  fs.writeFileSync(path.join(publicRoot, 'generated', 'a.png'), Buffer.from('png-on-disk'));
  fs.writeFileSync(path.join(publicRoot, 'generated', 'big.jpg'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(path.dirname(publicRoot), `${path.basename(publicRoot)}-secret.txt`), 'SECRET');
  process.env.PUBLIC_DIR = publicRoot;
  process.env.BACKEND_URL = 'https://my.linkeon.io';
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.MINIO_PUBLIC_URL;
  delete process.env.MINIO_ENDPOINT;
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  fs.rmSync(publicRoot, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(publicRoot), `${path.basename(publicRoot)}-secret.txt`), { force: true });
  __setSafeFetchDepsForTests(null);
});

describe('ownStaticPath', () => {
  it('относительная и абсолютная ссылка на наш /static/ — файл внутри public/', () => {
    expect(ownStaticPath('/static/generated/a.png')!.file).toBe(path.join(publicRoot, 'generated', 'a.png'));
    expect(ownStaticPath('https://my.linkeon.io/static/generated/a.png?v=2')!.file).toBe(path.join(publicRoot, 'generated', 'a.png'));
  });

  it('чужой хост, другой путь, протокол-относительная ссылка — не наше', () => {
    expect(ownStaticPath('https://evil.example/static/generated/a.png')).toBeNull();
    expect(ownStaticPath('//evil.example/static/generated/a.png')).toBeNull();
    expect(ownStaticPath('https://my.linkeon.io/smm-media/linkeon-assets/a.png')).toBeNull();
    expect(ownStaticPath('не ссылка')).toBeNull();
  });

  it('точки-сегменты сворачиваются WHATWG — /static/../x уже не /static/', () => {
    expect(ownStaticPath('/static/../.env')).toBeNull();
    expect(ownStaticPath('/static/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });

  it.each([
    '/static/..%2f..%2fetc%2fpasswd',
    '/static/generated/..%2F..%2F..%2Fsecret.txt',
    '/static/.env',
    '/static/generated/.hidden',
    '/static/generated%5c..%5c..%5csecret.txt',
    '/static/generated/a.png%00.jpg',
    '/static/',
  ])('%s — попытка выйти за public/ или скрытый файл — отказ', (u) => {
    expect(() => ownStaticPath(u)).toThrow(UnsafeUrlError);
  });
});

describe('fetchMediaBytes', () => {
  it('свой /static/ читается с диска, тип по расширению, в сеть не ходит', async () => {
    const resolve = jest.fn();
    __setSafeFetchDepsForTests({ resolve });
    const m = await fetchMediaBytes('/static/generated/a.png', { maxBytes: 1000, timeoutMs: 1000 });
    expect(m.data.toString()).toBe('png-on-disk');
    expect(m.contentType).toBe('image/png');
    expect(m.finalUrl).toBe('https://my.linkeon.io/static/generated/a.png');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('нет файла — понятная ошибка; больше лимита — отказ', async () => {
    await expect(fetchMediaBytes('/static/generated/none.png', { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(/не найден/);
    await expect(fetchMediaBytes('/static/generated/big.jpg', { maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'ERR_TOO_LARGE' });
  });

  it('файл за пределами public/ не читается', async () => {
    const name = `${path.basename(publicRoot)}-secret.txt`;
    await expect(fetchMediaBytes(`/static/..%2f${name}`, { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(UnsafeUrlError);
  });

  it('относительный /smm-media/… — через наш MinIO изнутри', async () => {
    const hits: string[] = [];
    const srv = http.createServer((req, res) => { hits.push(req.url || ''); res.setHeader('Content-Type', 'image/webp'); res.end('from-minio'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      process.env.MINIO_PUBLIC_URL = 'https://my.linkeon.io/smm-media';
      process.env.MINIO_ENDPOINT = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const m = await fetchMediaBytes('/smm-media/linkeon-assets/images/x.webp', { maxBytes: 1000, timeoutMs: 2000 });
      expect(m.data.toString()).toBe('from-minio');
      expect(m.contentType).toBe('image/webp');
      expect(hits).toEqual(['/linkeon-assets/images/x.webp']);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('чужая ссылка во внутреннюю сеть — отказ', async () => {
    __setSafeFetchDepsForTests({ resolve: async () => [{ address: '10.1.1.1', family: 4 }] });
    await expect(fetchMediaBytes('https://evil.example/a.png', { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(UnsafeUrlError);
    await expect(fetchMediaBytes('http://169.254.169.254/latest/meta-data/', { maxBytes: 1000, timeoutMs: 1000, allowHttp: true })).rejects.toThrow(UnsafeUrlError);
  });
});

describe('assertFetchableMedia — предпроверка до списания', () => {
  it('своё проходит без DNS', async () => {
    const resolve = jest.fn();
    __setSafeFetchDepsForTests({ resolve });
    process.env.MINIO_PUBLIC_URL = 'https://my.linkeon.io/smm-media';
    process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';
    await expect(assertFetchableMedia('/static/generated/a.png')).resolves.toBeUndefined();
    await expect(assertFetchableMedia('https://my.linkeon.io/smm-media/linkeon-smm-videos/video-uploads/u/1.jpg')).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('чужое: публичное — да, внутреннее — отказ', async () => {
    __setSafeFetchDepsForTests({
      resolve: async (h) => [{ address: h === 'good.example' ? '93.184.216.34' : '192.168.0.10', family: 4 }],
    });
    await expect(assertFetchableMedia('https://good.example/p.jpg')).resolves.toBeUndefined();
    await expect(assertFetchableMedia('https://bad.example/p.jpg')).rejects.toThrow(UnsafeUrlError);
    await expect(assertFetchableMedia('http://good.example/p.jpg')).rejects.toThrow(/https/);
    await expect(assertFetchableMedia('http://good.example/p.jpg', { allowHttp: true })).resolves.toBeUndefined();
  });

  it('toAbsoluteUrl: только одиночный слэш — свой сайт', () => {
    expect(toAbsoluteUrl('/smm-media/a.png')).toBe('https://my.linkeon.io/smm-media/a.png');
    expect(toAbsoluteUrl('//evil.example/a.png')).toBe('//evil.example/a.png');
    expect(toAbsoluteUrl('https://x.example/a.png')).toBe('https://x.example/a.png');
  });
});
