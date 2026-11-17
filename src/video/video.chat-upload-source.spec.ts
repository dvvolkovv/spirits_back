import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { VideoService } from './video.service';
import { VideoModule } from './video.module';
import { ChatUploadsService } from '../chat/chat-uploads/chat-uploads.service';
import { ChatUploadsModule } from '../chat/chat-uploads/chat-uploads.module';
import { __setSafeFetchDepsForTests } from '../common/net/safe-fetch';

/**
 * Видео из портрета по загрузке пользователя (spec 2026-11-16-chat-uploads-media-notes).
 * Фото читается из приватного бакета только владельцем; чужая загрузка или
 * не картинка — 400 до списания. В задачу пишется адрес без подписи: подпись
 * живёт час, а перезапуск сегмента читает фото позже — по владельцу задачи.
 */

const OWN = '77777777-7777-4777-8777-777777777777';
const PDF = '99999999-9999-4999-8999-999999999999';
const HEIC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JPG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CANON = `https://my.linkeon.io/webhook/chat-uploads/${OWN}`;
const FACE_B64 = Buffer.from('face-bytes').toString('base64');

const UPLOADS: Record<string, { mime: string; size_bytes: number; storage_key: string; original_name: string }> = {
  [OWN]: { mime: 'image/jpeg', size_bytes: 10, storage_key: `${OWN}/face.jpg`, original_name: 'face.jpg' },
  [PDF]: { mime: 'application/pdf', size_bytes: 10, storage_key: `${PDF}/cv.pdf`, original_name: 'cv.pdf' },
  [HEIC]: { mime: 'image/heic', size_bytes: 10, storage_key: `${HEIC}/IMG_0001.HEIC`, original_name: 'IMG_0001.HEIC' },
  [JPG]: { mime: 'image/jpg', size_bytes: 10, storage_key: `${JPG}/face.jpg`, original_name: 'face.jpg' },
};

function uploadRow(id: string) {
  return {
    id, user_id: 'u-1', session_id: 'u-1_12', sha256: 'e'.repeat(64), created_at: new Date('2026-11-10T10:00:00Z'),
    source: 'web', thumb_key: null, note: null, note_updated_at: null, note_assistant_id: null,
    ...UPLOADS[id],
  };
}

function makeService() {
  const clientCalls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM chat_uploads/.test(sql)) {
        const [id, userId] = params;
        return { rows: UPLOADS[id] && userId === 'u-1' ? [uploadRow(id)] : [], rowCount: 0 };
      }
      if (/COUNT\(\*\)::int AS n FROM video_jobs/.test(sql)) return { rows: [{ n: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    getClient: jest.fn(async () => ({
      query: async (sql: string, params: any[] = []) => {
        clientCalls.push({ sql, params });
        if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 10_000_000 }], rowCount: 1 };
        if (/INSERT INTO video_jobs/.test(sql)) return { rows: [{ id: 'job-1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    })),
  };
  const veo = { isConfigured: () => true, startGenerate: jest.fn(async () => 'op-1') };
  const uploadStorage = { download: jest.fn(async () => Buffer.from('face-bytes')) };
  const uploads = new ChatUploadsService(pg as any, uploadStorage as any);
  const svc = new VideoService(pg as any, veo as any, {} as any, undefined, undefined, uploads);
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { svc, clientCalls, veo, uploadStorage };
}

const billed = (calls: { sql: string }[]) => calls.some((c) => /consume_user_tokens|INSERT INTO video_jobs/.test(c.sql));
const DTO = { mode: 'image2video', model: 'veo-3.1', prompt: 'говорит в камеру: привет' };

const ENV_KEYS = ['BACKEND_URL', 'PUBLIC_BASE_URL', 'CHAT_UPLOADS_ENABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.BACKEND_URL = 'https://my.linkeon.io';
  delete process.env.PUBLIC_BASE_URL;
  process.env.CHAT_UPLOADS_ENABLED = 'true';
  __setSafeFetchDepsForTests({ resolve: async () => [{ address: '10.0.0.2', family: 4 }] });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __setSafeFetchDepsForTests(null);
  jest.restoreAllMocks();
});

describe('Veo: портрет из загрузки пользователя', () => {
  it.each([
    `/webhook/chat-uploads/${OWN}`,
    `${CANON}?exp=1&sig=deadbeef`,
  ])('%s — фото из бакета уходит в Veo, в задаче адрес без подписи', async (src) => {
    const { svc, clientCalls, veo, uploadStorage } = makeService();
    const r = await svc.createJob('u-1', { ...DTO, sourceImageUrl: src } as any);
    expect(r).toMatchObject({ jobId: 'job-1', status: 'processing' });
    const insert = clientCalls.find((c) => /INSERT INTO video_jobs/.test(c.sql))!;
    expect(insert.params[5]).toBe(CANON);
    expect(JSON.parse(insert.params[8]).veo_reference_images).toEqual([CANON]);
    expect(veo.startGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImagesB64: [{ b64: FACE_B64, mime: 'image/jpeg' }] }),
    );
    expect(uploadStorage.download).toHaveBeenCalledWith({ bucket: 'linkeon-chat-uploads', key: `${OWN}/face.jpg` });
  });

  it('чужая загрузка — 400 до списания и до Veo', async () => {
    const { svc, clientCalls, veo } = makeService();
    const err = await svc.createJob('u-2', { ...DTO, sourceImageUrl: `/webhook/chat-uploads/${OWN}` } as any).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/не найдена/);
    expect(billed(clientCalls)).toBe(false);
    expect(veo.startGenerate).not.toHaveBeenCalled();
  });

  it('загрузка-не картинка — 400 до списания', async () => {
    const { svc, clientCalls, veo } = makeService();
    const err = await svc.createJob('u-1', { ...DTO, sourceImageUrls: [`/webhook/chat-uploads/${PDF}`] } as any).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/не картинка/);
    expect(billed(clientCalls)).toBe(false);
    expect(veo.startGenerate).not.toHaveBeenCalled();
  });

  it('HEIC — портрету Omni не подходит: 400 до списания', async () => {
    const { svc, clientCalls, veo } = makeService();
    const err = await svc.createJob('u-1', { ...DTO, sourceImageUrl: `/webhook/chat-uploads/${HEIC}` } as any).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/не картинка/);
    expect(billed(clientCalls)).toBe(false);
    expect(veo.startGenerate).not.toHaveBeenCalled();
  });

  it('image/jpg уходит в Omni как image/jpeg', async () => {
    const { svc, veo } = makeService();
    await svc.createJob('u-1', { ...DTO, sourceImageUrl: `/webhook/chat-uploads/${JPG}` } as any);
    expect(veo.startGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImagesB64: [{ b64: FACE_B64, mime: 'image/jpeg' }] }),
    );
  });

  it('сбой хранилища на проверке — не отказ: фото пропускается, как при сетевом сбое', async () => {
    const { svc, veo, uploadStorage } = makeService();
    uploadStorage.download.mockRejectedValue(Object.assign(
      new Error(`The specified key does not exist: ${OWN}/face.jpg`),
      { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } },
    ));
    const r = await svc.createJob('u-1', { ...DTO, sourceImageUrl: `/webhook/chat-uploads/${OWN}` } as any);
    expect(r.status).toBe('processing');
    expect(veo.startGenerate).toHaveBeenCalledWith(expect.objectContaining({ referenceImagesB64: [] }));
    // В журнал — вид ошибки, без текста S3 с ключом и именем файла.
    const warns = ((svc as any).logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.join('\n')).toContain('хранилище загрузок не ответило (NoSuchKey status=404)');
    expect(warns.join('\n')).not.toMatch(/face\.jpg|specified key/);
  });

  it('перезапуск сегмента читает фото по владельцу задачи, без подписи', async () => {
    const { svc, veo } = makeService();
    await (svc as any).restartVeoSegment(
      { id: 'job-1', user_id: 'u-1', source_image_url: CANON, prompt: 'p', negative_prompt: null, tokens_spent: 1 },
      { segments_done: 0, veo_reference_images: [CANON], veo_segment_prompts: ['p'], veo_aspect_ratio: '16:9', veo_resolution: '720p' },
    );
    expect(veo.startGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImagesB64: [{ b64: FACE_B64, mime: 'image/jpeg' }] }),
    );
  });

  it('fetchReferenceImagesB64: чужому владельцу — фото пропускается (мягко, как раньше)', async () => {
    const { svc } = makeService();
    await expect((svc as any).fetchReferenceImagesB64([CANON], 'u-2')).resolves.toEqual([]);
    await expect((svc as any).fetchReferenceImagesB64([CANON], 'u-1')).resolves.toEqual([{ b64: FACE_B64, mime: 'image/jpeg' }]);
  });

  it('флаг выключен — адрес загрузки идёт прежним путём (защита от внутренней сети), реестр не читается', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'false';
    const { svc, clientCalls, uploadStorage } = makeService();
    const err = await svc.createJob('u-1', { ...DTO, sourceImageUrl: `/webhook/chat-uploads/${OWN}` } as any).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/внутреннюю сеть/);
    expect(uploadStorage.download).not.toHaveBeenCalled();
    expect(billed(clientCalls)).toBe(false);
  });
});

describe('VideoModule: загрузки чата как исходник', () => {
  it('импортирует ChatUploadsModule; VideoService получает ChatUploadsService настоящим классом', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, VideoModule)).toContain(ChatUploadsModule);
    expect(Reflect.getMetadata('design:paramtypes', VideoService)[5]).toBe(ChatUploadsService);
  });
});
