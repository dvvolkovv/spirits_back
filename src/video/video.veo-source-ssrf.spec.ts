import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { BadRequestException } from '@nestjs/common';
import { VideoService } from './video.service';
import { __setSafeFetchDepsForTests } from '../common/net/safe-fetch';

/**
 * Veo: референс-фото (sourceImageUrl[s]) качаем МЫ и отправляем в Google, а
 * ссылку выбирает человек или модель. Ссылка во внутреннюю сеть не должна ни
 * скачиваться, ни стоить денег: отказ — до списания, с понятной причиной.
 */

function makeService() {
  const pgCalls: string[] = [];
  const pg = {
    query: jest.fn(async (sql: string) => { pgCalls.push(sql); return { rows: [{ n: 0 }], rowCount: 0 }; }),
    getClient: jest.fn(async () => ({ query: async (sql: string) => { pgCalls.push(sql); return { rows: [], rowCount: 0 }; }, release() {} })),
  };
  const veo = { isConfigured: () => true, startGenerate: jest.fn() };
  const svc = new VideoService(pg as any, {} as any, {} as any, veo as any, {} as any);
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { svc, pg, pgCalls, veo };
}

const saved: Record<string, string | undefined> = {};
let publicRoot: string;

beforeEach(() => {
  for (const k of ['PUBLIC_DIR', 'BACKEND_URL']) saved[k] = process.env[k];
  publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veo-ssrf-'));
  fs.mkdirSync(path.join(publicRoot, 'generated'));
  fs.writeFileSync(path.join(publicRoot, 'generated', 'face.jpg'), Buffer.from('face-bytes'));
  process.env.PUBLIC_DIR = publicRoot;
  process.env.BACKEND_URL = 'https://my.linkeon.io';
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(publicRoot, { recursive: true, force: true });
  __setSafeFetchDepsForTests(null);
  jest.restoreAllMocks();
});

describe('Veo: ссылки на фото', () => {
  it.each([
    'http://127.0.0.1:9000/linkeon-assets/me.jpg',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:6379/',
    'https://looks-public.example/me.jpg', // резолвится во внутренний адрес
  ])('%s — 400 с причиной ДО списания и до Veo', async (url) => {
    __setSafeFetchDepsForTests({ resolve: async () => [{ address: '10.0.0.2', family: 4 }] });
    const get = jest.spyOn(axios, 'get');
    const { svc, pgCalls, veo } = makeService();
    const err = await svc.createJob('u-1', { mode: 'image2video', model: 'veo-3.1', prompt: 'говорит в камеру', sourceImageUrl: url } as any).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/ссылка не принята: адрес ведёт во внутреннюю сеть/);
    expect(pgCalls.some((s) => /consume_user_tokens|INSERT INTO video_jobs/.test(s))).toBe(false);
    expect(veo.startGenerate).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('fetchPortraitB64: внутренний адрес не качается, отказ мягкий (null), как у сетевого сбоя', async () => {
    const { svc } = makeService();
    await expect((svc as any).fetchPortraitB64('http://127.0.0.1:9000/x.jpg')).resolves.toBeNull();
    await expect((svc as any).fetchPortraitB64('/static/..%2f..%2fetc%2fpasswd')).resolves.toBeNull();
  });

  it('fetchPortraitB64: своё фото из /static/ читается с диска', async () => {
    const { svc } = makeService();
    const p = await (svc as any).fetchPortraitB64('/static/generated/face.jpg');
    expect(p).toEqual({ b64: Buffer.from('face-bytes').toString('base64'), mime: 'image/jpeg' });
  });
});
