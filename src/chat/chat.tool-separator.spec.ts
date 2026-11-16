import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Пункты edf8fe49, c3e49a84: текст до шага работы и текст после него
 * склеивались («файл.Готово»). Разделитель (block-separator.ts) ставится у
 * всех трёх потребителей потока релея — веб-ход, ход с файлом, agentReply — и
 * в поток клиенту, и в то, что ложится в историю.
 */

const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business' };
const ev = (e: object) => `data: ${JSON.stringify(e)}\n`;
const STREAM = [
  ev({ type: 'delta', text: 'Сейчас посмотрю файл.' }),
  ev({ type: 'tool', tool: 'Read', input: '{}' }),
  ev({ type: 'delta', text: 'Готово: всё сходится.' }),
  ev({ type: 'done', costUsd: 0.1 }),
];
const JOINED = 'Сейчас посмотрю файл.\n\nГотово: всё сходится.';

function makeService() {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      if (/FROM agents WHERE id/.test(sql)) return { rows: [AGENT] };
      if (/SELECT profile_data FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ profile_data: {} }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined,
  );
  return { svc, calls };
}

const post = jest.fn();
beforeEach(() => {
  post.mockReset();
  (axios as any).default = { post };
  (axios as any).post = post;
});

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function newRes(): any {
  return {
    status: jest.fn().mockReturnThis(), setHeader: jest.fn(), write: jest.fn(() => true),
    end: jest.fn(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(),
  };
}
function writes(res: any): any[] {
  const out: any[] = [];
  for (const c of res.write.mock.calls) {
    for (const line of String(c[0]).split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* не JSON — не наше */ }
    }
  }
  return out;
}
const items = (res: any) => writes(res).filter((w) => w.type === 'item').map((w) => w.content);
const ends = (res: any) => writes(res).filter((w) => w.type === 'end');
const saved = (calls: { params: any[] }[]) => calls.flatMap((c) => c.params).filter((p) => typeof p === 'string');

describe('разделитель после шага работы — у всех потребителей потока релея', () => {
  it('веб-ход: в потоке клиенту, в end и в истории', async () => {
    const { svc, calls } = makeService();
    post.mockResolvedValueOnce({ data: Readable.from(STREAM) });
    const res = newRes();
    await (svc as any).streamUniversalAgent(
      'u1', 'проверь', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    await settle();

    expect(items(res).join('')).toBe(JOINED);
    expect(ends(res)[0].content).toBe(JOINED);
    expect(saved(calls)).toContain(JOINED);
  });

  it('ход с файлом: в потоке клиенту, в end и в истории', async () => {
    const { svc, calls } = makeService();
    post.mockResolvedValueOnce({ data: Readable.from(STREAM) });
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
    const req = {
      headers: { authorization: 'Bearer t' },
      files: [{ originalname: 'a.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
      body: { message: 'смотри файл', assistantId: '7' },
    } as any;
    const res = newRes();
    await ctrl.uploadAndChat(req, res);
    await settle();

    expect(items(res).join('')).toBe(JOINED);
    expect(ends(res)[0].content).toBe(JOINED);
    expect(saved(calls)).toContain(JOINED);
  });

  it('agentReply (рутины, «Путь»): возвращённый текст', async () => {
    const { svc } = makeService();
    post.mockResolvedValueOnce({ data: Readable.from(STREAM) });
    await expect(svc.generateAgentReply('u1', '12', 'напомни')).resolves.toBe(JOINED);
  });
});
