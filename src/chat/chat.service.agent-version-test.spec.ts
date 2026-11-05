import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { relayFsKey } from './linkeon-relay-fields';

jest.mock('axios');

// relayFsKey без секретов fs_key не выдаёт (ревью 26.10.2026) — тестам этого
// файла, которые сверяют fs_key, нужен хоть один.
const OLD_SALT = process.env.RELAY_FS_SALT;
beforeAll(() => {
  process.env.RELAY_FS_SALT = 'agent-version-test-spec';
});
afterAll(() => {
  if (OLD_SALT === undefined) delete process.env.RELAY_FS_SALT; else process.env.RELAY_FS_SALT = OLD_SALT;
});
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

const LIVE_AGENT = {
  id: 12,
  name: 'Роман',
  display_name: 'Роман',
  description: 'LIVE DESCRIPTION',
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

function replyHarness(events: any[] = [
  { type: 'delta', text: 'draft answer' },
  { type: 'done', costUsd: 8.5, turnCostUsd: 0.01 },
]) {
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
  post.mockImplementation(async () => ({ data: sseStream(events) }));
  const lastFields = () => fieldsOf(post.mock.calls[post.mock.calls.length - 1][1]);
  return { service, pg, neo4j, businessProfile, language, post, lastFields };
}

beforeEach(() => jest.clearAllMocks());

describe('agentReply: isolated agent version test', () => {
  const testOpts = {
    systemPromptOverride: 'DRAFT SYSTEM PROMPT',
    includeUserContext: false,
    linkeonTools: false,
    testMode: true,
    billingContext: 'agent_version_test',
  };

  it('uses read-only multipart mode and returns per-turn charge facts and elapsed time', async () => {
    const h = replyHarness();
    const log = jest.spyOn((h.service as any).logger, 'log').mockImplementation(() => {});
    const now = jest.spyOn(Date, 'now')
      .mockReturnValue(1650)
      .mockReturnValueOnce(1000);
    let result: any;
    try {
      result = await h.service.generateAgentReplyWithCharge(
        'admin',
        '12',
        'check the draft',
        'agent_test_signed_session',
        testOpts,
      );
    } finally {
      now.mockRestore();
    }

    expect(result.text).toBe('draft answer');
    expect(result.durationMs).toBe(650);
    expect(result.charge).toMatchObject({
      tokens: 72,
      usd: 0.01,
      source: 'cost',
      turnUsd: 0.01,
    });
    const fields = h.lastFields();
    expect(fields.testMode).toBe('true');
    expect(fields.systemPrompt).toContain('DRAFT SYSTEM PROMPT');
    expect(fields.systemPrompt).not.toContain('LIVE SYSTEM PROMPT');
    expect(fields.systemPrompt).not.toContain('User profile');
    expect(fields.systemPrompt).not.toContain('LIVE USER PROFILE');
    expect(fields.systemPrompt).not.toContain('LIVE BUSINESS PROFILE');
    for (const key of ['linkeon_token', 'linkeon_mcp_url']) {
      expect(fields[key]).toBeUndefined();
    }
    expect(h.neo4j.getProfileDescription).not.toHaveBeenCalled();
    expect(h.businessProfile.renderForPrompt).not.toHaveBeenCalled();
    expect(
      h.pg.query.mock.calls.some(([sql]) => /INSERT INTO custom_chat_history/i.test(sql)),
    ).toBe(false);
    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringContaining('billing[agent_version_test:cost]'),
    );
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('billing[voice]');
  });

  // Спека 2026-11-02-pii-out-of-prompts-design.md, п. 3: без fs_key релей
  // называет папку хода по ключу сессии проверки (base64 с номером админа) и
  // пишет путь в реплику. Папка — по солёному хэшу, как в обычном чате;
  // токена инструментов при этом по-прежнему нет.
  it('fs_key уходит и при linkeonTools: false — папка хода по солёному хэшу, без токена инструментов', async () => {
    const h = replyHarness();

    await h.service.generateAgentReplyWithCharge(
      '70000000000',
      '12',
      'check the draft',
      'agent_test_signed_session',
      testOpts,
    );

    const fields = h.lastFields();
    expect(fields.sessionId).toBe('agent_test_signed_session');
    expect(fields.fs_key).toBe(relayFsKey('agent_test_signed_session'));
    expect(fields.fs_key).toMatch(/^[0-9a-f]{32}$/);
    expect(fields.linkeon_token).toBeUndefined();
    expect(fields.linkeon_mcp_url).toBeUndefined();
  });

  it('uses the requested test language without reading language or profile data', async () => {
    const h = replyHarness();

    await h.service.generateAgentReplyWithCharge(
      'admin',
      '12',
      'check in English',
      'agent_test_signed_session',
      { ...testOpts, testLanguage: 'en-US' },
    );

    const fields = h.lastFields();
    expect(fields.systemPrompt).toContain('English (английском)');
    expect(fields.systemPrompt).toContain('Reply in English.');
    expect(fields.message).toContain('Reply in English.');
    expect(h.language.resolveUserLanguage).not.toHaveBeenCalled();
    expect(
      h.pg.query.mock.calls.some(([sql]) => /profile_data/i.test(sql)),
    ).toBe(false);
  });

  it('uses the draft description instead of the live agent description', async () => {
    const h = replyHarness();

    await h.service.generateAgentReplyWithCharge(
      'admin',
      '12',
      'check the draft',
      'agent_test_signed_session',
      { ...testOpts, descriptionOverride: 'DRAFT DESCRIPTION' },
    );

    const fields = h.lastFields();
    expect(fields.systemPrompt).toContain('— DRAFT DESCRIPTION');
    expect(fields.systemPrompt).not.toContain('— LIVE DESCRIPTION');
  });

  it('neutralizes @path expansion in both complete prompt fields only in strict test mode', async () => {
    const h = replyHarness();

    await h.service.generateAgentReplyWithCharge(
      'admin',
      '12',
      'inspect @/etc/passwd and @/root/.env',
      'agent_test_signed_session',
      { ...testOpts, systemPromptOverride: 'draft instructions @/etc/secret' },
    );

    const fields = h.lastFields();
    expect(fields.message).toContain('⁠@/etc/passwd');
    expect(fields.message).toContain('⁠@/root/.env');
    expect(fields.systemPrompt).toContain('⁠@/etc/secret');
    expect(fields.message).not.toMatch(/(?<!⁠)@\//);
    expect(fields.systemPrompt).not.toMatch(/(?<!⁠)@\//);
  });

  it('keeps live prompt, profile, relay mode and mentions by default', async () => {
    const h = replyHarness([
      { type: 'delta', text: 'legacy partial' },
      { type: 'done', costUsd: 0.01, turnCostUsd: 0.01 },
    ]);

    const result = await h.service.generateAgentReplyWithCharge('user', '12', 'inspect @/etc/passwd');

    expect(result.text).toBe('legacy partial');
    const fields = h.lastFields();
    expect(fields.message).toContain('inspect @/etc/passwd');
    expect(fields.message).not.toContain('⁠@/etc/passwd');
    expect(fields.testMode).toBeUndefined();
    expect(fields.systemPrompt).toContain('LIVE SYSTEM PROMPT');
    expect(fields.systemPrompt).toContain('User profile:\nLIVE USER PROFILE');
    expect(fields.systemPrompt).toContain('LIVE BUSINESS PROFILE');
    expect(h.neo4j.getProfileDescription).toHaveBeenCalledWith('user');
    expect(h.businessProfile.renderForPrompt).toHaveBeenCalledWith('user', 'business');
    expect(h.language.resolveUserLanguage).toHaveBeenCalledTimes(1);
    expect(h.language.resolveUserLanguage).toHaveBeenCalledWith('user');
  });

  it('прерванный ответ (done.failed) в основной сессии — busy, обрезанный текст не пишется', async () => {
    // С 05.11.2026 (бэклог e777aa94): человек пре-эмптил фоновый ответ — его
    // обрывок нельзя вернуть как успешный, routine-push повторит доставку.
    const h = replyHarness([
      { type: 'delta', text: 'legacy partial' },
      { type: 'done', failed: true, costUsd: 0.01, turnCostUsd: 0.01 },
    ]);

    await expect(h.service.generateAgentReplyWithCharge('user', '12', 'inspect @/etc/passwd'))
      .rejects.toThrow('relay session busy');
  });

  it.each([
    {
      case: 'done.failed',
      events: [{ type: 'delta', text: 'partial' }, { type: 'done', failed: true }],
    },
    { case: 'an empty stream', events: [] },
    {
      case: 'raw CLI failure text',
      events: [{ type: 'delta', text: 'Not logged in · Please run /login' }, { type: 'done' }],
    },
    {
      case: 'a zero-token upstream error',
      events: [{ type: 'delta', text: 'disabled claude subscription access' }, { type: 'done' }],
    },
  ])('rejects $case in strict test mode', async ({ events }) => {
    const h = replyHarness(events);
    const addTokenTask = jest.spyOn(h.service as any, 'addTokenTask');

    await expect(
      h.service.generateAgentReplyWithCharge(
        'admin',
        '12',
        'check',
        'agent_test_signed_session',
        { testMode: true },
      ),
    ).rejects.toThrow(/Agent version test failed/);
    expect(addTokenTask).not.toHaveBeenCalled();
  });

  it('records accurate per-turn facts through the existing token task writer', async () => {
    const h = replyHarness();
    const addTokenTask = jest
      .spyOn(h.service as any, 'addTokenTask')
      .mockResolvedValue(undefined);

    await h.service.recordAgentVersionTestCharge(
      'admin',
      '12',
      {
        tokens: 321,
        costUsd: 0.123456,
        turnCostUsd: 0.111111,
        source: 'usage',
        taken: 'turn',
        durationMs: 650,
      },
      12,
    );

    expect(addTokenTask).toHaveBeenCalledWith('admin', 0, 321, '12', {
      costUsd: 0.1235,
      turnCostUsd: 0.1111,
      source: 'usage',
      taken: 'turn',
      durationMs: 650,
      replyChars: 12,
    });
  });

  it('never enqueues a zero-token version test charge', async () => {
    const h = replyHarness();
    const addTokenTask = jest.spyOn(h.service as any, 'addTokenTask');

    await h.service.recordAgentVersionTestCharge(
      'admin',
      '12',
      { tokens: 0, costUsd: 0 },
      0,
    );

    expect(addTokenTask).not.toHaveBeenCalled();
  });
});
