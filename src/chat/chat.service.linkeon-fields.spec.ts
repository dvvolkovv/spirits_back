import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { relaySessionKey } from './relay-session';
import { relayFsKey } from './linkeon-relay-fields';
import { verifyLinkeonToolToken } from '../mcp/linkeon-tool.token';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Поля инструментов Linkeon (linkeon_token, linkeon_mcp_url, fs_key) на путях
 * с известным пользователем — спека 2026-10-26-mcp-turn-token-design.md.
 * Гоняются НАСТОЯЩИЕ streamUniversalAgent и agentReply с замоканными
 * axios/pg/res — как в chat.service.help-fields.spec.ts.
 */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Поля multipart-запроса к релею — то, что реально уехало. */
function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const OLD_SECRET = process.env.JWT_SECRET;
const realSetTimeout = global.setTimeout;
beforeAll(() => {
  process.env.JWT_SECRET = 'linkeon-fields-spec';
  // persistResponse ставит таймер очистки dedup-карты; без unref jest не выходит.
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => {
  (global as any).setTimeout = realSetTimeout;
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_SECRET;
});
beforeEach(() => jest.clearAllMocks());

const SID = relaySessionKey('u-test', '12', 'ru');

function streamHarness(events: any[], sessionFiles: (url: string) => any[] = () => []) {
  const pg = { query: jest.fn(async (sql: string) => (/AS spent/.test(sql) ? { rows: [{ spent: 0 }] } : { rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({ data: sseStream(events) }));
  const get = axios.get as jest.Mock;
  get.mockImplementation(async (url: string) => ({ data: sessionFiles(url) }));
  const written: any[] = [];
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((line: string) => { try { written.push(JSON.parse(line)); } catch {} return true; }),
    end: jest.fn(),
  };
  const run = async () => {
    await (svc as any).streamUniversalAgent(
      'u-test', 'сделай отчёт', '12', '12', [], '', res, 'Роман', '', '', undefined, false,
      undefined, undefined, undefined, undefined, undefined, false, { activity: true, ask: false },
    );
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  };
  return { run, post, get, written };
}

describe('streamUniversalAgent: поля инструментов Linkeon', () => {
  it('ход везёт токен хода, адрес точки и fs_key своей сессии', async () => {
    const h = streamHarness([{ type: 'delta', text: 'ок' }, { type: 'done' }]);
    await h.run();
    const f = fieldsOf(h.post.mock.calls[0][1]);
    expect(f.sessionId).toBe(SID);
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u-test' });
    expect(f.linkeon_mcp_url).toMatch(/^https:\/\/.+\/webhook\/mcp\/linkeon$/);
    expect(f.fs_key).toBe(relayFsKey(SID));
  });

  it('шаг работы: загрузка с префиксом fs_key — без префикса', async () => {
    const h = streamHarness([
      { type: 'tool', tool: 'Read', input: JSON.stringify({ file_path: `/tmp/agent-uploads/${relayFsKey(SID)}_egrul.pdf` }) },
      { type: 'delta', text: 'ок' },
      { type: 'done' },
    ]);
    await h.run();
    expect(h.written).toContainEqual({ type: 'activity', kind: 'read_upload', detail: 'egrul.pdf' });
  });

  it('пустые скобки: файлы сессии — сначала по fs_key, пусто — по ключу сессии хода', async () => {
    const h = streamHarness([{ type: 'delta', text: 'Готово: [Скачать report.pdf]()' }, { type: 'done' }]);
    await h.run();
    expect(h.get.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining(`/session/${relayFsKey(SID)}/files`),
      expect.stringContaining(`/session/${SID}/files`),
    ]);
  });

  it('нашлось по fs_key — второй раз релей не спрашивают', async () => {
    const fsKey = relayFsKey(SID);
    const h = streamHarness(
      [{ type: 'delta', text: 'Готово: [Скачать report.pdf]()' }, { type: 'done' }],
      (url) => (url.includes(`/session/${fsKey}/`) ? [{ name: 'report.pdf', url: `/files/${fsKey}/report.pdf`, size: 1 }] : []),
    );
    await h.run();
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.get.mock.calls[0][0]).toContain(`/session/${fsKey}/files`);
  });
});

describe('agentReply: поля инструментов Linkeon', () => {
  const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business' };
  function replyHarness() {
    const pg = { query: jest.fn(async (sql: string) => (/FROM agents WHERE id/.test(sql) ? { rows: [AGENT] } : { rows: [] })) };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
    const post = axios.post as jest.Mock;
    post.mockImplementation(async () => ({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) }));
    const last = () => fieldsOf(post.mock.calls[post.mock.calls.length - 1][1]);
    return { svc, last };
  }

  it('рутина и «Путь» (без своей сессии): токен пользователя, fs_key его сессии', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReply('u-routine', '12', 'утренний текст');
    const f = last();
    const sid = relaySessionKey('u-routine', '12', 'ru');
    expect(f.sessionId).toBe(sid);
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u-routine' });
    expect(f.fs_key).toBe(relayFsKey(sid));
  });

  it('итоги звонка (своя сессия): fs_key — от этой сессии', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReply('u-voice', '12', 'итоги', 'voice_summary_abc');
    const f = last();
    expect(f.sessionId).toBe('voice_summary_abc');
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u-voice' });
    expect(f.fs_key).toBe(relayFsKey('voice_summary_abc'));
  });

  it('голосовой документ (со списанием): поля тоже есть', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReplyWithCharge('u-voice', '12', 'документ', 'voice_doc_c1_d1');
    const f = last();
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u-voice' });
    expect(f.fs_key).toBe(relayFsKey('voice_doc_c1_d1'));
  });

  it('linkeonTools: false (проба качества) — полей нет', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReply('70000000000', '12', 'проба', 'qprobe_12_1', { linkeonTools: false });
    const f = last();
    expect(f.sessionId).toBe('qprobe_12_1');
    for (const k of ['linkeon_token', 'linkeon_mcp_url', 'fs_key']) expect(f[k]).toBeUndefined();
  });
});
