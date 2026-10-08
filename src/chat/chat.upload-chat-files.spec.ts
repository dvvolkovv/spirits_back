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
});
