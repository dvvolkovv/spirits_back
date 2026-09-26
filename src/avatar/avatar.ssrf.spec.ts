import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import axios from 'axios';
import { AvatarController, __resetAgentAvatarCache } from './avatar.controller';
import { __setSafeFetchDepsForTests } from '../common/net/safe-fetch';

/**
 * `profile_data.avatar_url` пишет сам пользователь (POST /profile-update
 * вливает в profile_data любые ключи), а GET /avatar отдавал по нему:
 *   • `/static/…` — любой файл сервера через `..` (sendFile по склеенному пути);
 *   • внешний адрес — байты ответа, в том числе внутреннего сервиса.
 */

function makeRes() {
  return {
    headers: {} as Record<string, string>,
    body: null as any,
    statusCode: 200,
    redirectedTo: null as string | null,
    sentFile: null as string | null,
    ended: false,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    send(b: any) { this.body = b; return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(o: any) { this.body = o; return this; },
    end() { this.ended = true; return this; },
    redirect(u: string) { this.redirectedTo = u; return this; },
    sendFile(f: string) { this.sentFile = f; return this; },
  };
}

function ctrlFor(url: string | null) {
  const service = { getAvatar: jest.fn(async () => (url ? { url } : null)), getAgentAvatar: jest.fn() };
  return { ctrl: new AvatarController(service as any), service };
}

const user = { userId: 'u-1' };
const saved: Record<string, string | undefined> = {};
let publicRoot: string;

beforeEach(() => {
  for (const k of ['PUBLIC_DIR', 'MINIO_PUBLIC_URL', 'MINIO_ENDPOINT', 'BACKEND_URL']) saved[k] = process.env[k];
  publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-ssrf-'));
  fs.mkdirSync(path.join(publicRoot, 'avatars'));
  fs.writeFileSync(path.join(publicRoot, 'avatars', 'u-1.jpg'), 'jpeg');
  process.env.PUBLIC_DIR = publicRoot;
  process.env.BACKEND_URL = 'https://my.linkeon.io';
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(publicRoot, { recursive: true, force: true });
  __setSafeFetchDepsForTests(null);
  jest.restoreAllMocks();
});

describe('GET /avatar: локальный путь', () => {
  it('законный /static/avatars/… отдаётся файлом из public/', async () => {
    const { ctrl } = ctrlFor('/static/avatars/u-1.jpg');
    const res = makeRes();
    await ctrl.getAvatar(user, res as any);
    expect(res.sentFile).toBe(path.join(publicRoot, 'avatars', 'u-1.jpg'));
  });

  it.each([
    '/static/../../../../etc/passwd',
    '/static/..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/static/avatars/..%2F..%2F..%2Fhome%2Fdvolkov%2Fbackups%2Flinkeon%2Fspirits_back.env',
    '/static/.env',
  ])('%s — ничего не отдаётся', async (url) => {
    const { ctrl } = ctrlFor(url);
    const res = makeRes();
    await ctrl.getAvatar(user, res as any);
    expect(res.sentFile).toBeNull();
    expect(res.statusCode).toBe(204);
  });
});

describe('GET /avatar: внешний адрес', () => {
  it.each([
    'http://127.0.0.1:9000/linkeon-assets/',
    'http://localhost:3001/webhook/admin/users',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:10.0.0.1]/',
    'file:///etc/passwd',
  ])('%s — не качается и браузер туда не отправляется', async (url) => {
    const spy = jest.spyOn(axios, 'request');
    const { ctrl } = ctrlFor(url);
    const res = makeRes();
    await ctrl.getAvatar(user, res as any);
    expect(res.statusCode).toBe(204);
    expect(res.redirectedTo).toBeNull();
    expect(res.body).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('имя, которое резолвится во внутренний адрес, — тоже', async () => {
    __setSafeFetchDepsForTests({ resolve: async () => [{ address: '10.0.0.9', family: 4 }] });
    const { ctrl } = ctrlFor('https://my-avatar.example/me.png');
    const res = makeRes();
    await ctrl.getAvatar(user, res as any);
    expect(res.statusCode).toBe(204);
    expect(res.redirectedTo).toBeNull();
  });

  describe('через наш MinIO', () => {
    let srv: http.Server;
    let contentType = 'image/png';
    beforeEach(async () => {
      srv = http.createServer((req, res) => {
        if (contentType) res.setHeader('Content-Type', contentType);
        res.end('avatar-bytes');
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      process.env.MINIO_PUBLIC_URL = 'https://my.linkeon.io/smm-media';
      process.env.MINIO_ENDPOINT = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    });
    afterEach(async () => { await new Promise<void>((r) => srv.close(() => r())); });

    it('картинка проксируется байтами, тип фиксируется', async () => {
      contentType = 'image/png';
      const { ctrl } = ctrlFor('https://my.linkeon.io/smm-media/linkeon-assets/avatars/users/u-1.png');
      const res = makeRes();
      await ctrl.getAvatar(user, res as any);
      expect(Buffer.from(res.body).toString()).toBe('avatar-bytes');
      expect(res.headers['Content-Type']).toBe('image/png');
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('тип не сообщили — отдаётся как JPEG, как и раньше', async () => {
      contentType = '';
      const { ctrl } = ctrlFor('https://my.linkeon.io/smm-media/linkeon-assets/avatars/users/u-1.jpg');
      const res = makeRes();
      await ctrl.getAvatar(user, res as any);
      expect(Buffer.from(res.body).toString()).toBe('avatar-bytes');
      expect(res.headers['Content-Type']).toBe('image/jpeg');
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('SVG — не аватар: документ со скриптами с нашего origin не отдаём', async () => {
      contentType = 'image/svg+xml';
      const { ctrl } = ctrlFor('https://my.linkeon.io/smm-media/linkeon-assets/avatars/users/u-1.png');
      const res = makeRes();
      await ctrl.getAvatar(user, res as any);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBeNull();
    });

    it('не картинка — не аватар (свой origin не отдаёт чужой HTML)', async () => {
      contentType = 'text/html; charset=utf-8';
      const { ctrl } = ctrlFor('https://my.linkeon.io/smm-media/linkeon-assets/x.html');
      const res = makeRes();
      await ctrl.getAvatar(user, res as any);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBeNull();
    });
  });
});

describe('GET /agent/avatar/:agentId', () => {
  beforeEach(() => __resetAgentAvatarCache());

  it.each(['../../webhook/profile', '..', '12/../../x', '12?x=1', '', 'a'.repeat(101)])(
    '%j — 404 без похода в сеть', async (agentId) => {
      const spy = jest.spyOn(axios, 'get');
      const service = { getAgentAvatar: jest.fn(async (id: string) => `https://my.linkeon.io/smm-media/linkeon-assets/avatars/agents/${id}.jpg`) };
      const ctrl = new AvatarController(service as any);
      const res = makeRes();
      await ctrl.getAgentAvatar(agentId, res as any);
      expect(res.statusCode).toBe(404);
      expect(service.getAgentAvatar).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    },
  );
});
