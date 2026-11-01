import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

const LIVE_AGENT = {
  id: 12,
  name: 'Роман',
  display_name: 'Роман',
  description: '',
  system_prompt: 'LIVE SYSTEM PROMPT',
  category: 'business',
};

function sseStream(events: any[]): Readable {
  const stream = new Readable({ read() {} });
  process.nextTick(() => {
    for (const event of events) stream.push(`data: ${JSON.stringify(event)}\n`);
    stream.push(null);
  });
  return stream;
}

function fieldsOf(form: any): Record<string, string> {
  const boundary = form.getBoundary();
  const raw = form.getBuffer().toString('utf8');
  const fields: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    fields[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return fields;
}

function replyHarness() {
  const pg = {
    query: jest.fn(async (sql: string) =>
      /FROM agents WHERE id/.test(sql) ? { rows: [LIVE_AGENT] } : { rows: [] }),
  };
  const neo4j = {
    getProfileDescription: jest.fn(async () => 'LIVE USER PROFILE'),
  };
  const businessProfile = {
    renderForPrompt: jest.fn(async () => 'LIVE BUSINESS PROFILE'),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const service = new ChatService(
    pg as any,
    neo4j as any,
    null as any,
    null as any,
    language as any,
    undefined,
    undefined,
    undefined,
    undefined,
    businessProfile as any,
  );
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({
    data: sseStream([
      { type: 'delta', text: 'draft answer' },
      { type: 'done', costUsd: 0.01, turnCostUsd: 0.01 },
    ]),
  }));
  const lastFields = () => fieldsOf(post.mock.calls[post.mock.calls.length - 1][1]);
  return { service, pg, neo4j, businessProfile, post, lastFields };
}

beforeEach(() => jest.clearAllMocks());

describe('agentReply: isolated agent version test', () => {
  it('uses the draft prompt without user context, Linkeon tools, or chat history', async () => {
    const h = replyHarness();

    const result = await h.service.generateAgentReplyWithCharge(
      'admin',
      '12',
      'check the draft',
      'agent_test_admin_0123456789abcdef0123456789abcdef',
      {
        systemPromptOverride: 'DRAFT SYSTEM PROMPT',
        includeUserContext: false,
        linkeonTools: false,
      },
    );

    expect(result.text).toBe('draft answer');
    const fields = h.lastFields();
    expect(fields.systemPrompt).toContain('DRAFT SYSTEM PROMPT');
    expect(fields.systemPrompt).not.toContain('LIVE SYSTEM PROMPT');
    expect(fields.systemPrompt).not.toContain('User profile');
    expect(fields.systemPrompt).not.toContain('LIVE USER PROFILE');
    expect(fields.systemPrompt).not.toContain('LIVE BUSINESS PROFILE');
    for (const key of ['linkeon_token', 'linkeon_mcp_url', 'fs_key']) {
      expect(fields[key]).toBeUndefined();
    }
    expect(h.neo4j.getProfileDescription).not.toHaveBeenCalled();
    expect(h.businessProfile.renderForPrompt).not.toHaveBeenCalled();
    expect(
      h.pg.query.mock.calls.some(([sql]) => /INSERT INTO custom_chat_history/i.test(sql)),
    ).toBe(false);
  });

  it('keeps the live prompt and existing profile behavior by default', async () => {
    const h = replyHarness();

    await h.service.generateAgentReply('user', '12', 'ordinary reply');

    const fields = h.lastFields();
    expect(fields.systemPrompt).toContain('LIVE SYSTEM PROMPT');
    expect(fields.systemPrompt).toContain('User profile:\nLIVE USER PROFILE');
    expect(fields.systemPrompt).toContain('LIVE BUSINESS PROFILE');
    expect(h.neo4j.getProfileDescription).toHaveBeenCalledWith('user');
    expect(h.businessProfile.renderForPrompt).toHaveBeenCalledWith('user', 'business');
  });

  it('records a version test charge through the existing token task writer', async () => {
    const h = replyHarness();
    const addTokenTask = jest
      .spyOn(h.service as any, 'addTokenTask')
      .mockResolvedValue(undefined);

    await h.service.recordAgentVersionTestCharge(
      'admin',
      '12',
      { tokens: 321, costUsd: 0.123456 },
      12,
    );

    expect(addTokenTask).toHaveBeenCalledWith('admin', 0, 321, '12', {
      costUsd: 0.1235,
      source: 'cost',
      durationMs: 0,
      replyChars: 12,
    });
  });
});
