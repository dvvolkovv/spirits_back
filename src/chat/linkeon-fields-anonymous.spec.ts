import { Readable } from 'stream';
import axios from 'axios';
import { CleanAskService } from '../ask/clean-ask.service';
import { BlogRelayClient } from '../blog/blog-relay.client';

jest.mock('axios');

/**
 * Анонимные и служебные ходы — без инструментов Linkeon (спека
 * 2026-10-26-mcp-turn-token-design.md, «Кто не получает»): у clean-ask и
 * первого контакта пользователя нет по замыслу, у автоблога — вовсе.
 */
const LINKEON_FIELDS = ['linkeon_token', 'linkeon_mcp_url', 'fs_key'];

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

const lastFields = () => {
  const calls = (axios.post as jest.Mock).mock.calls;
  return fieldsOf(calls[calls.length - 1][1]);
};

beforeEach(() => {
  jest.clearAllMocks();
  (axios.post as jest.Mock).mockImplementation(async () => ({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) }));
});

describe('анонимные и служебные ходы — без полей инструментов Linkeon', () => {
  const agents = { getAgentByName: jest.fn(async () => null), getAgentById: jest.fn(async () => null) };

  it('clean-ask', async () => {
    await new CleanAskService(agents as any).ask('как дела?');
    const f = lastFields();
    expect(f.sessionId).toMatch(/^anon_/);
    for (const k of LINKEON_FIELDS) expect(f[k]).toBeUndefined();
  });

  it('первый контакт', async () => {
    await new CleanAskService(agents as any).firstContact([{ from: 'user', text: 'привет' }], false);
    for (const k of LINKEON_FIELDS) expect(lastFields()[k]).toBeUndefined();
  });

  it('автоблог', async () => {
    await new BlogRelayClient().ask('системный промпт', 'сообщение', 'blog_spec_1');
    for (const k of LINKEON_FIELDS) expect(lastFields()[k]).toBeUndefined();
  });
});
