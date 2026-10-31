import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/** agentReply: модель ответов — личный выбор или общий рубильник (spec 2026-10-31-global-llm-switch, раздел 4). */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

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

const realSetTimeout = global.setTimeout;
beforeAll(() => {
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => { (global as any).setTimeout = realSetTimeout; });
beforeEach(() => jest.clearAllMocks());

const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business' };
function replyHarness(route?: { provider: 'claude' | 'qwen' | 'kimi'; choice: 'user' | 'global' }) {
  const pg = { query: jest.fn(async (sql: string) => (/FROM agents WHERE id/.test(sql) ? { rows: [AGENT] } : { rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
  if (route) (svc as any).llmProvider = { route: jest.fn(async () => route) };
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) }));
  const last = () => fieldsOf(post.mock.calls[post.mock.calls.length - 1][1]);
  return { svc, last };
}

describe('agentReply: модель в запросе к релею', () => {
  it('«Как у всех» при рубильнике Qwen — provider=qwen', async () => {
    const { svc, last } = replyHarness({ provider: 'qwen', choice: 'global' });
    await svc.generateAgentReply('u-1', '12', 'итоги', 'voice_summary_1');
    expect(last().provider).toBe('qwen');
    expect(last().noFallback).toBeUndefined();
  });

  it('личный Kimi — provider=kimi (и со списанием)', async () => {
    const { svc, last } = replyHarness({ provider: 'kimi', choice: 'user' });
    await svc.generateAgentReplyWithCharge('u-1', '12', 'вопрос', 'voice_12_1');
    expect(last().provider).toBe('kimi');
  });

  it('личный Claude — без provider', async () => {
    const { svc, last } = replyHarness({ provider: 'claude', choice: 'user' });
    await svc.generateAgentReply('u-1', '12', 'итоги', 'voice_summary_2');
    expect(last().provider).toBeUndefined();
  });

  it('без сервиса выбора — без provider (как раньше)', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReply('u-1', '12', 'итоги', 'voice_summary_3');
    expect(last().provider).toBeUndefined();
  });
});
