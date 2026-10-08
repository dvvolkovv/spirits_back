// src/chat/chat.upload-chat-files.spec.ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Ход с вложениями (`POST /webhook/agent/upload-and-chat`) — вторая,
 * самостоятельная реализация стрима. Файлы релея там должны уходить ссылкой на
 * наше хранилище так же, как в текстовом ходе.
 */

const RELAY_FILE = 'https://r.linkeon.io/files/u1_12_ru/scan.docx';
const STORED = 'https://pub/linkeon-chat-files/11111111-2222-4333-8444-555555555555/scan.docx';

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makePg() {
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
    return { rows: [] };
  });
  return { query, calls };
}

function makeRes() {
  const written: any[] = [];
  return {
    written,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { try { written.push(JSON.parse(s)); } catch {} return true; }),
    end: jest.fn(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

async function run(store: any) {
  const pg = makePg();
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    store,
  );
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
  const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
  const post = jest.fn(async () => ({
    data: sseStream([
      { type: 'delta', text: 'Перевёл.' },
      { type: 'done', outputFiles: [{ name: 'scan.docx', url: '/files/u1_12_ru/scan.docx' }] },
    ]),
  }));
  (axios as any).default = { post };
  (axios as any).post = post;
  const req = {
    headers: { authorization: 'Bearer token' },
    files: [{ originalname: 'scan.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 1 }],
    body: { message: 'переведи', assistantId: '12' },
  } as any;
  const res = makeRes();
  await ctrl.uploadAndChat(req, res);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const saved = pg.calls.find((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /'ai'/.test(c.sql))?.params[2];
  return { res, saved: saved as string | undefined };
}

describe('uploadAndChat — файлы хода в нашем хранилище', () => {
  beforeEach(() => { jest.clearAllMocks(); delete process.env.AGENT_URL; });

  it('ссылка уходит в поток, в end и в историю уже с нашим адресом', async () => {
    const store = { persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, STORED]))) };
    const { res, saved } = await run(store);

    expect(store.persist).toHaveBeenCalledWith([RELAY_FILE]);
    const items = res.written.filter((w: any) => w.type === 'item').map((w: any) => w.content);
    expect(items).toContain(`\n\n[Скачать scan.docx](${STORED})`);
    expect(res.written.find((w: any) => w.type === 'end').content).toContain(STORED);
    expect(saved).toContain(`[Скачать scan.docx](${STORED})`);
    expect(saved).not.toContain('r.linkeon.io');
  });

  it('копия не удалась — ссылка на релей, как раньше', async () => {
    const store = { persist: jest.fn(async () => new Map<string, string>()) };
    const { res, saved } = await run(store);

    const items = res.written.filter((w: any) => w.type === 'item').map((w: any) => w.content);
    expect(items).toContain(`\n\n[Скачать scan.docx](${RELAY_FILE})`);
    expect(saved).toContain(RELAY_FILE);
  });

  // Fix 6: relay-links.storeRelayLinks сама не бросает (ловит сбой persist
  // внутри и возвращает исходные строки), поэтому единственный способ
  // проверить страховку КОНТРОЛЛЕРА — заставить бросить саму обёртку
  // ChatService.storeRelayLinks (например, будущий баг выше по цепочке).
  // Без local try/catch (chat.controller.ts, finally) это уронило бы finally
  // целиком — клиент не получил бы ни `end`, ни res.end(), ни историю.
  it('ChatService.storeRelayLinks бросила — ответ и история всё равно уходят, со ссылкой на релей', async () => {
    const pg = makePg();
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const svc = new ChatService(
      pg as any, null as any, null as any, null as any, null as any, language as any,
      undefined, undefined, undefined, undefined,
    );
    jest.spyOn(svc, 'storeRelayLinks').mockRejectedValue(new Error('boom'));
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
    const post = jest.fn(async () => ({
      data: sseStream([
        { type: 'delta', text: 'Перевёл.' },
        { type: 'done', outputFiles: [{ name: 'scan.docx', url: '/files/u1_12_ru/scan.docx' }] },
      ]),
    }));
    (axios as any).default = { post };
    (axios as any).post = post;
    const req = {
      headers: { authorization: 'Bearer token' },
      files: [{ originalname: 'scan.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 1 }],
      body: { message: 'переведи', assistantId: '12' },
    } as any;
    const res = makeRes();

    await ctrl.uploadAndChat(req, res);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    const items = res.written.filter((w: any) => w.type === 'item').map((w: any) => w.content);
    expect(items).toContain(`\n\n[Скачать scan.docx](${RELAY_FILE})`);
    expect(res.written.find((w: any) => w.type === 'end')).toBeDefined();
    expect(res.end).toHaveBeenCalled();
    const saved = pg.calls.find((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /'ai'/.test(c.sql))?.params[2];
    expect(saved).toContain(RELAY_FILE);
  });
});

describe('uploadAndChat — activeStreams (beginStream/endStream)', () => {
  beforeEach(() => { jest.clearAllMocks(); delete process.env.AGENT_URL; });

  it('ход занят в activeStreams пока идёт копия файлов, свободен после сохранения истории', async () => {
    const pg = makePg();
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    let resolvePersist!: (v: Map<string, string>) => void;
    const store = {
      persist: jest.fn(() => new Promise<Map<string, string>>((resolve) => { resolvePersist = resolve; })),
    };
    const svc = new ChatService(
      pg as any, null as any, null as any, null as any, null as any, language as any,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      store as any,
    );
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
    const post = jest.fn(async () => ({
      data: sseStream([
        { type: 'delta', text: 'Перевёл.' },
        { type: 'done', outputFiles: [{ name: 'scan.docx', url: '/files/u1_12_ru/scan.docx' }] },
      ]),
    }));
    (axios as any).default = { post };
    (axios as any).post = post;
    const req = {
      headers: { authorization: 'Bearer token' },
      files: [{ originalname: 'scan.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 1 }],
      body: { message: 'переведи', assistantId: '12' },
    } as any;
    const res = makeRes();

    const done = ctrl.uploadAndChat(req, res);
    // Копия «висит» на persist (promise не резолвится) — ход обязан быть
    // виден в activeStreams: иначе deploy.sh счёл бы его свободным и мог
    // рестартовать процесс посреди ~60-секундной копии в MinIO.
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    expect(svc.getActiveStreamCount()).toBe(1);

    resolvePersist(new Map([[RELAY_FILE, STORED]]));
    await done;
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    expect(svc.getActiveStreamCount()).toBe(0);
  });

  it('апстрим упал без единого байта текста — activeStreams возвращается в 0', async () => {
    const pg = makePg();
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const svc = new ChatService(
      pg as any, null as any, null as any, null as any, null as any, language as any,
      undefined, undefined, undefined, undefined,
    );
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
    const post = jest.fn(async () => { throw new Error('connect refused'); });
    (axios as any).default = { post };
    (axios as any).post = post;
    const req = {
      headers: { authorization: 'Bearer token' },
      files: [{ originalname: 'scan.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 1 }],
      body: { message: 'переведи', assistantId: '12' },
    } as any;
    const res = makeRes();

    await ctrl.uploadAndChat(req, res);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    expect(svc.getActiveStreamCount()).toBe(0);
  });

  // beginStream/endStream раньше были завязаны на то, какая из веток finally
  // выполнится дальше (есть текст / есть что персистить / нет). Бросок
  // где-то посреди finally, ДО ветки с setImmediate, уводил activeStreams в
  // вечный плюс — deploy.sh ждал бы несуществующий ход до своего таймаута.
  it('бросок внутри finally (computeUploadCharge) — activeStreams всё равно возвращается в 0', async () => {
    const pg = makePg();
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const store = { persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, STORED]))) };
    const svc = new ChatService(
      pg as any, null as any, null as any, null as any, null as any, language as any,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      store as any,
    );
    jest.spyOn(svc, 'computeUploadCharge').mockImplementation(() => { throw new Error('computeUploadCharge boom'); });
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
    const post = jest.fn(async () => ({
      data: sseStream([
        { type: 'delta', text: 'Перевёл.' },
        { type: 'done', outputFiles: [{ name: 'scan.docx', url: '/files/u1_12_ru/scan.docx' }] },
      ]),
    }));
    (axios as any).default = { post };
    (axios as any).post = post;
    const req = {
      headers: { authorization: 'Bearer token' },
      files: [{ originalname: 'scan.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 1 }],
      body: { message: 'переведи', assistantId: '12' },
    } as any;
    const res = makeRes();

    await ctrl.uploadAndChat(req, res).catch(() => {});
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    expect(svc.getActiveStreamCount()).toBe(0);
  });
});
