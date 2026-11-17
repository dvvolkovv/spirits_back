import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { MiscService } from './misc.service';
import { MiscModule } from './misc.module';
import { ChatUploadsService } from '../chat/chat-uploads/chat-uploads.service';
import { ChatUploadsModule } from '../chat/chat-uploads/chat-uploads.module';
import { __setSafeFetchDepsForTests, UnsafeUrlError } from '../common/net/safe-fetch';

/**
 * Загрузка пользователя как исходник правки картинок (spec
 * 2026-11-16-chat-uploads-media-notes). Адрес /webhook/chat-uploads/<id>
 * читается из приватного бакета только владельцем хода: только image/*, не
 * больше 8 МБ. Отказ — до похода в Gemini и до списания токенов. Внешние
 * ссылки идут прежним путём с защитой от SSRF.
 */

const OWN = '77777777-7777-4777-8777-777777777777';
const PDF = '99999999-9999-4999-8999-999999999999';
const BIG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GIF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HEIC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JPG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const UPLOADS: Record<string, { mime: string; size_bytes: number; storage_key: string; original_name: string }> = {
  [OWN]: { mime: 'image/png', size_bytes: 9, storage_key: `${OWN}/room.png`, original_name: 'room.png' },
  [PDF]: { mime: 'application/pdf', size_bytes: 9, storage_key: `${PDF}/doc.pdf`, original_name: 'doc.pdf' },
  [BIG]: { mime: 'image/jpeg', size_bytes: 9 * 1024 * 1024, storage_key: `${BIG}/big.jpg`, original_name: 'big.jpg' },
  [GIF]: { mime: 'image/gif', size_bytes: 9, storage_key: `${GIF}/anim.gif`, original_name: 'anim.gif' },
  [HEIC]: { mime: 'image/heic', size_bytes: 9, storage_key: `${HEIC}/IMG_0001.HEIC`, original_name: 'IMG_0001.HEIC' },
  [JPG]: { mime: 'image/jpg', size_bytes: 9, storage_key: `${JPG}/photo.jpg`, original_name: 'photo.jpg' },
};

/** Строка chat_uploads владельца u-1 со всеми колонками 001 и 002. */
function uploadRow(id: string) {
  return {
    id, user_id: 'u-1', session_id: 'u-1_12', sha256: 'd'.repeat(64), created_at: new Date('2026-11-10T10:00:00Z'),
    source: 'web', thumb_key: null, note: null, note_updated_at: null, note_assistant_id: null,
    ...UPLOADS[id],
  };
}

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 100000 }] };
      if (/FROM chat_uploads/.test(sql)) {
        const [id, userId] = params;
        return { rows: UPLOADS[id] && userId === 'u-1' ? [uploadRow(id)] : [] };
      }
      return { rows: [] };
    }),
  };
  const storage = { upload: jest.fn(async () => 'https://my.linkeon.io/smm-media/linkeon-assets/images/out.png') };
  const uploadStorage = { download: jest.fn(async () => Buffer.from('png-bytes')) };
  // Настоящий ChatUploadsService: владелец проверяется его SQL, а не моком.
  const uploads = new ChatUploadsService(pg as any, uploadStorage as any);
  const svc = new MiscService(null as any, pg as any, storage as any, null as any, uploads);
  return { svc, pg, uploadStorage };
}

function mockGemini() {
  return jest.spyOn(axios, 'post').mockResolvedValue({
    data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('edited').toString('base64') } }] } }] },
  } as any);
}

const charged = (pg: { query: jest.Mock }) =>
  pg.query.mock.calls.some((c: any[]) => /consume_user_tokens|UPDATE ai_profiles_consolidated/.test(String(c[0])));

const ENV_KEYS = ['GOOGLE_AI_API_KEY', 'PUBLIC_DIR', 'BACKEND_URL', 'PUBLIC_BASE_URL', 'CHAT_UPLOADS_ENABLED'];
const saved: Record<string, string | undefined> = {};
let publicRoot: string;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.GOOGLE_AI_API_KEY = 'test-key';
  process.env.BACKEND_URL = 'https://my.linkeon.io';
  delete process.env.PUBLIC_BASE_URL;
  process.env.CHAT_UPLOADS_ENABLED = 'true';
  publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'misc-upload-src-'));
  fs.mkdirSync(path.join(publicRoot, 'generated'));
  fs.writeFileSync(path.join(publicRoot, 'generated', 'bg.jpg'), Buffer.from('jpeg-background'));
  process.env.PUBLIC_DIR = publicRoot;
  // Реальной сети нет: любое имя «резолвится» во внутренний адрес, и любой
  // внешний поход заканчивается UnsafeUrlError.
  __setSafeFetchDepsForTests({ resolve: async () => [{ address: '10.20.30.40', family: 4 }] });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(publicRoot, { recursive: true, force: true });
  __setSafeFetchDepsForTests(null);
  jest.restoreAllMocks();
});

describe('правка картинок: исходник — загрузка пользователя', () => {
  it.each([
    `/webhook/chat-uploads/${OWN}`,
    `https://my.linkeon.io/webhook/chat-uploads/${OWN}?exp=1&sig=deadbeef`,
  ])('%s — своя картинка читается из бакета и уходит в Gemini', async (src) => {
    const post = mockGemini();
    const { svc, uploadStorage } = makeService();
    const r = await svc.editImage('u-1', { prompt: 'сделай стены зелёными', sourceImageUrl: src });
    expect(r.images[0].url).toBe('https://my.linkeon.io/smm-media/linkeon-assets/images/out.png');
    const inline = (post.mock.calls[0][1] as any).contents[0].parts[1].inlineData;
    expect(inline.mimeType).toBe('image/png');
    expect(Buffer.from(inline.data, 'base64').toString()).toBe('png-bytes');
    expect(uploadStorage.download).toHaveBeenCalledWith({ bucket: 'linkeon-chat-uploads', key: `${OWN}/room.png` });
  });

  it('upscale своей загрузки: userId доходит через editImage', async () => {
    const post = mockGemini();
    const { svc } = makeService();
    await svc.upscaleImage('u-1', { sourceImageUrl: `/webhook/chat-uploads/${OWN}` });
    const inline = (post.mock.calls[0][1] as any).contents[0].parts[1].inlineData;
    expect(Buffer.from(inline.data, 'base64').toString()).toBe('png-bytes');
  });

  it('склейка: загрузка и свой /static/ — оба исходника в Gemini', async () => {
    const post = mockGemini();
    const { svc } = makeService();
    await svc.composeImage('u-1', { prompt: 'посади на этот фон', sourceImageUrls: [`/webhook/chat-uploads/${OWN}`, '/static/generated/bg.jpg'] });
    const parts = (post.mock.calls[0][1] as any).contents[0].parts;
    expect(Buffer.from(parts[1].inlineData.data, 'base64').toString()).toBe('png-bytes');
    expect(Buffer.from(parts[2].inlineData.data, 'base64').toString()).toBe('jpeg-background');
  });

  it('чужая загрузка — отказ до Gemini и до списания, байты не читаются', async () => {
    const post = jest.spyOn(axios, 'post');
    const { svc, pg, uploadStorage } = makeService();
    await expect(svc.editImage('u-2', { prompt: 'p', sourceImageUrl: `/webhook/chat-uploads/${OWN}` })).rejects.toThrow(/не найдена/);
    await expect(
      svc.composeImage('u-2', { prompt: 'p', sourceImageUrls: ['/static/generated/bg.jpg', `/webhook/chat-uploads/${OWN}`] }),
    ).rejects.toThrow(/не найдена/);
    expect(post).not.toHaveBeenCalled();
    expect(uploadStorage.download).not.toHaveBeenCalled();
    expect(charged(pg)).toBe(false);
  });

  it('не картинка (PDF) — отказ до Gemini', async () => {
    const post = jest.spyOn(axios, 'post');
    const { svc, pg } = makeService();
    await expect(svc.editImage('u-1', { prompt: 'p', sourceImageUrl: `/webhook/chat-uploads/${PDF}` })).rejects.toThrow(/не картинка/);
    expect(post).not.toHaveBeenCalled();
    expect(charged(pg)).toBe(false);
  });

  it('GIF — картинка не из белого списка Gemini: отказ до Gemini и до списания', async () => {
    const post = jest.spyOn(axios, 'post');
    const { svc, pg } = makeService();
    await expect(svc.editImage('u-1', { prompt: 'p', sourceImageUrl: `/webhook/chat-uploads/${GIF}` })).rejects.toThrow(/не картинка/);
    expect(post).not.toHaveBeenCalled();
    expect(charged(pg)).toBe(false);
  });

  it('HEIC с айфона уходит в Gemini как есть, image/jpg — как image/jpeg', async () => {
    const post = mockGemini();
    const { svc } = makeService();
    await svc.editImage('u-1', { prompt: 'p', sourceImageUrl: `/webhook/chat-uploads/${HEIC}` });
    await svc.editImage('u-1', { prompt: 'p', sourceImageUrl: `/webhook/chat-uploads/${JPG}` });
    expect((post.mock.calls[0][1] as any).contents[0].parts[1].inlineData.mimeType).toBe('image/heic');
    expect((post.mock.calls[1][1] as any).contents[0].parts[1].inlineData.mimeType).toBe('image/jpeg');
  });

  it('сбой хранилища — ошибка без текста S3: ни ключа, ни имени файла; Gemini и списания нет', async () => {
    const post = jest.spyOn(axios, 'post');
    const { svc, pg, uploadStorage } = makeService();
    uploadStorage.download.mockRejectedValue(Object.assign(
      new Error(`The specified key does not exist: ${OWN}/room.png`),
      { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } },
    ));
    const err = await svc.editImage('u-1', { prompt: 'p', sourceImageUrl: `/webhook/chat-uploads/${OWN}` }).catch((e) => e);
    expect(err.message).toBe('хранилище загрузок не ответило (NoSuchKey status=404)');
    expect(err.message).not.toMatch(/room\.png|specified key/);
    expect(post).not.toHaveBeenCalled();
    expect(charged(pg)).toBe(false);
  });

  it('больше 8 МБ — отказ без скачивания', async () => {
    const post = jest.spyOn(axios, 'post');
    const { svc, uploadStorage } = makeService();
    await expect(svc.editImage('u-1', { prompt: 'p', sourceImageUrl: `/webhook/chat-uploads/${BIG}` })).rejects.toThrow(/больше 8 МБ/);
    expect(uploadStorage.download).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('правка картинок: прочие адреса — прежним путём', () => {
  it.each([
    'https://images.example/cat.png',
    `https://evil.example/webhook/chat-uploads/${OWN}`,
  ])('%s — внешняя ссылка: прежняя защита от SSRF, реестр не читается', async (src) => {
    const post = jest.spyOn(axios, 'post');
    const { svc, pg, uploadStorage } = makeService();
    await expect(svc.editImage('u-1', { prompt: 'p', sourceImageUrl: src })).rejects.toThrow(UnsafeUrlError);
    expect(pg.query.mock.calls.some((c: any[]) => /FROM chat_uploads/.test(String(c[0])))).toBe(false);
    expect(uploadStorage.download).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('флаг выключен — адрес загрузки идёт прежним путём, реестр не читается', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'false';
    const { svc, pg, uploadStorage } = makeService();
    await expect(svc.editImage('u-1', { prompt: 'p', sourceImageUrl: `/webhook/chat-uploads/${OWN}` })).rejects.toThrow(UnsafeUrlError);
    expect(pg.query.mock.calls.some((c: any[]) => /FROM chat_uploads/.test(String(c[0])))).toBe(false);
    expect(uploadStorage.download).not.toHaveBeenCalled();
  });
});

describe('MiscModule: загрузки чата как исходник', () => {
  it('импортирует ChatUploadsModule; MiscService получает ChatUploadsService настоящим классом', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, MiscModule)).toContain(ChatUploadsModule);
    expect(Reflect.getMetadata('design:paramtypes', MiscService)[4]).toBe(ChatUploadsService);
  });
});
