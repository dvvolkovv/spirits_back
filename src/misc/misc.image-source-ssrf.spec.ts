import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { MiscService } from './misc.service';
import { __setSafeFetchDepsForTests, UnsafeUrlError } from '../common/net/safe-fetch';

/**
 * Правка/апскейл/склейка картинок качают исходник по sourceImageUrl, а его
 * выбирает человек (POST /imageedit и соседи) или модель (инструменты чата,
 * маркеры TG-бота). Раньше:
 *   • внешний адрес качался axios'ом как есть — в том числе внутренний;
 *   • `/static/…` склеивался в путь без проверки и читал любой файл сервера.
 * Отказ должен случаться ДО похода в Gemini и ДО списания токенов.
 */

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 100000 }] };
      return { rows: [] };
    }),
  };
  const storage = { upload: jest.fn(async () => 'https://my.linkeon.io/smm-media/linkeon-assets/images/out.png') };
  const svc = new MiscService(null as any, pg as any, storage as any, null as any);
  return { svc, pg, storage };
}

const saved: Record<string, string | undefined> = {};
let publicRoot: string;

beforeEach(() => {
  for (const k of ['GOOGLE_AI_API_KEY', 'PUBLIC_DIR', 'BACKEND_URL']) saved[k] = process.env[k];
  process.env.GOOGLE_AI_API_KEY = 'test-key';
  process.env.BACKEND_URL = 'https://my.linkeon.io';
  publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'misc-ssrf-'));
  fs.mkdirSync(path.join(publicRoot, 'generated'));
  fs.writeFileSync(path.join(publicRoot, 'generated', 'src.jpg'), Buffer.from('jpeg-source'));
  process.env.PUBLIC_DIR = publicRoot;
  // Реальной сети в тестах нет: любое имя «резолвится» во внутренний адрес.
  __setSafeFetchDepsForTests({ resolve: async () => [{ address: '10.20.30.40', family: 4 }] });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(publicRoot, { recursive: true, force: true });
  __setSafeFetchDepsForTests(null);
  jest.restoreAllMocks();
});

describe('editImage / upscaleImage / composeImage: исходник по чужой ссылке', () => {
  it.each([
    'http://127.0.0.1:9000/linkeon-assets/secret.png',
    'http://localhost:3001/webhook/admin/users',
    'http://169.254.169.254/latest/meta-data/',
    'https://images.example/cat.png', // имя резолвится во внутренний адрес
    '/static/generated/..%2f..%2f..%2fetc%2fpasswd',
    '/static/.env',
    'file:///etc/passwd',
  ])('%s — отказ до Gemini и до списания', async (src) => {
    const post = jest.spyOn(axios, 'post');
    const { svc, pg } = makeService();
    await expect(svc.editImage('u-1', { prompt: 'сделай фон синим', sourceImageUrl: src })).rejects.toThrow(UnsafeUrlError);
    await expect(svc.upscaleImage('u-1', { sourceImageUrl: src })).rejects.toThrow(UnsafeUrlError);
    await expect(
      svc.composeImage('u-1', { prompt: 'склей', sourceImageUrls: ['/static/generated/src.jpg', src] }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(post).not.toHaveBeenCalled();
    expect(pg.query.mock.calls.some((c: any[]) => /consume_user_tokens|UPDATE ai_profiles_consolidated/.test(c[0]))).toBe(false);
  });

  it('свой /static/generated/… читается с диска и уходит в Gemini — правка работает как раньше', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('edited').toString('base64') } }] } }] },
    } as any);
    const { svc, storage } = makeService();
    const r = await svc.editImage('u-1', { prompt: 'сделай фон синим', sourceImageUrl: '/static/generated/src.jpg' });
    expect(r.images[0].url).toBe('https://my.linkeon.io/smm-media/linkeon-assets/images/out.png');
    const body = post.mock.calls[0][1] as any;
    const inline = body.contents[0].parts[1].inlineData;
    expect(inline.mimeType).toBe('image/jpeg');
    expect(Buffer.from(inline.data, 'base64').toString()).toBe('jpeg-source');
    expect(storage.upload).toHaveBeenCalled();
  });
});
