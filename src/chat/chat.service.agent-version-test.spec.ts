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

function responseHarness() {
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
    json: jest.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.end.mockImplementation(() => { res.writableEnded = true; });
  return res;
}

function replyHarness(events: any[] = [
  { type: 'delta', text: 'draft answer' },
  { type: 'done', costUsd: 8.5, turnCostUsd: 0.01 },
], opts: {
  automaticProfiling?: boolean;
  tasksContext?: string;
  profilingSequence?: boolean[];
  agentSystemPrompt?: string;
} = {}) {
  const profilingSequence = [...(opts.profilingSequence || [])];
  const agentSystemPrompt = opts.agentSystemPrompt || LIVE_AGENT.system_prompt;
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/SELECT profile_data FROM ai_profiles_consolidated/i.test(sql)) {
        const automaticProfiling = profilingSequence.length > 0
          ? profilingSequence.shift()
          : opts.automaticProfiling ?? true;
        return { rows: [{ profile_data: { automaticProfiling } }] };
      }
      return /FROM agents WHERE id/.test(sql)
        ? { rows: [{ ...LIVE_AGENT, system_prompt: agentSystemPrompt }] }
        : { rows: [] };
    }),
  };
  const neo4j = {
    getProfileDescription: jest.fn(async () => 'LIVE USER PROFILE'),
  };
  const businessProfile = {
    renderForPrompt: jest.fn(async () => 'LIVE BUSINESS PROFILE'),
  };
  const tasksService = {
    buildContextForPrompt: jest.fn(async () => opts.tasksContext || ''),
    extractFromTurn: jest.fn(async () => {}),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const service = new ChatService(
    pg as any,
    neo4j as any,
    null as any,
    null as any,
    language as any,
    undefined,
    tasksService as any,
    undefined,
    undefined,
    businessProfile as any,
  );
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({ data: sseStream(events) }));
  const lastFields = () => fieldsOf(post.mock.calls[post.mock.calls.length - 1][1]);
  return { service, pg, neo4j, businessProfile, tasksService, language, post, lastFields, agentSystemPrompt };
}

beforeEach(() => jest.clearAllMocks());

async function runRelayPrivacyTurn(h: ReturnType<typeof replyHarness>) {
  const addTokenTask = jest.spyOn(h.service as any, 'addTokenTask').mockResolvedValue(undefined);
  const realSetTimeout = global.setTimeout;
  const timers: NodeJS.Timeout[] = [];
  // Ускоряем только два известных таймера хода. Колбэки обязательно выполняются:
  // иначе self-heal после пустого ответа навсегда ждёт свои 800 мс.
  const timer = jest.spyOn(global, 'setTimeout').mockImplementation((
    (callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
      const actualDelay = delay === 800 || delay === 14_000 ? 0 : delay;
      const handle = realSetTimeout(callback, actualDelay, ...args);
      timers.push(handle);
      return handle;
    }
  ) as any);

  try {
    const streaming = (h.service as any).streamUniversalAgent(
      'user',
      'check relay privacy',
      '12',
      '12',
      [],
      'LIVE USER PROFILE',
      responseHarness(),
      'Роман',
      'LIVE DESCRIPTION',
      h.agentSystemPrompt,
      undefined,
      false,
      undefined,
      'ru',
      undefined,
      '',
      'business',
    );
    let watchdog: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      streaming.then(() => 'settled'),
      new Promise<string>((resolve) => {
        watchdog = realSetTimeout(() => resolve('watchdog'), 250);
        timers.push(watchdog);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);
    expect(outcome).toBe('settled');

    // persistResponse запускается через setImmediate после возврата stream.
    // Несколько check-фаз дают завершиться и записи истории, и списанию, и
    // немедленному dedup-cleanup — всё ещё под безопасными spy.
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(addTokenTask).toHaveBeenCalledTimes(1);
  } finally {
    for (const handle of timers) clearTimeout(handle);
    timer.mockRestore();
    addTokenTask.mockRestore();
  }

  // После восстановления не должно оживать ни отложенное списание, ни настоящий
  // 14-секундный таймер. Это отдельная проверка границы жизненного цикла теста.
  const lateAddTokenTask = jest.spyOn(h.service as any, 'addTokenTask');
  const lateTimer = jest.spyOn(global, 'setTimeout');
  try {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(lateAddTokenTask).not.toHaveBeenCalled();
    expect(lateTimer).not.toHaveBeenCalledWith(expect.any(Function), 14_000);
  } finally {
    for (const result of lateTimer.mock.results) {
      if (result.type === 'return') clearTimeout(result.value);
    }
    lateTimer.mockRestore();
    lateAddTokenTask.mockRestore();
  }
}

const PERSONAL_BLOCK = 'User profile:\nLIVE USER PROFILE\n\n';
const BUSINESS_BLOCK = 'LIVE BUSINESS PROFILE\n\n';
const PERSONA_WITH_PROFILE_COPIES =
  `PERSONA BEFORE\n${PERSONAL_BLOCK}${BUSINESS_BLOCK}PERSONA AFTER`;

function expectOnlyPersonaCopies(prompt: string) {
  // Одна копия каждого блока была в персоне до builder, вторую вставил builder.
  // После отзыва должна остаться ровно персональная, а не более поздняя profile copy.
  expect(prompt.split(PERSONAL_BLOCK)).toHaveLength(2);
  expect(prompt.split(BUSINESS_BLOCK)).toHaveLength(2);
  expect(prompt).toContain(
    `--- Персона и инструкции ассистента Роман ---\n${PERSONA_WITH_PROFILE_COPIES}\n\n`,
  );
}

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

  it('drops pre-materialized agentReply profile and business data after revocation', async () => {
    const h = replyHarness(undefined, { automaticProfiling: false });

    await h.service.generateAgentReply('user', '12', 'check privacy', 'privacy_revoked_session');

    const fields = h.lastFields();
    const outbound = `${fields.systemPrompt || ''}\n${fields.message}`;
    expect(h.neo4j.getProfileDescription).toHaveBeenCalledWith('user');
    expect(outbound).not.toContain('LIVE USER PROFILE');
    expect(outbound).not.toContain('User profile:');
    expect(outbound).not.toContain('LIVE BUSINESS PROFILE');
    expect(h.businessProfile.renderForPrompt).not.toHaveBeenCalled();
  });

  it('drops pre-materialized relay profile and business data after revocation but keeps tasks', async () => {
    const h = replyHarness(undefined, {
      automaticProfiling: false,
      tasksContext: 'ACTIVE TASKS MARKER',
    });

    await runRelayPrivacyTurn(h);

    expect(h.post).toHaveBeenCalledTimes(1);
    const fields = h.lastFields();
    expect(fields.systemPrompt).not.toContain('LIVE USER PROFILE');
    expect(fields.systemPrompt).not.toContain('User profile:');
    expect(fields.systemPrompt).not.toContain('LIVE BUSINESS PROFILE');
    expect(fields.message).not.toContain('LIVE USER PROFILE');
    expect(fields.message).toContain('ACTIVE TASKS MARKER');
    expect(fields.sessionId).toBe('user_12_ru_noprofiling');
    expect(h.tasksService.buildContextForPrompt).toHaveBeenCalledWith('user', 'check relay privacy');
    expect(h.businessProfile.renderForPrompt).not.toHaveBeenCalled();
  });

  it('completes relay self-heal when the first response is empty', async () => {
    const h = replyHarness(undefined, {
      automaticProfiling: false,
      tasksContext: 'ACTIVE TASKS MARKER',
    });
    h.post
      .mockImplementationOnce(async () => ({ data: sseStream([]) }))
      .mockImplementationOnce(async () => ({
        data: sseStream([
          { type: 'delta', text: 'retry answer' },
          { type: 'done', costUsd: 0.01, turnCostUsd: 0.01 },
        ]),
      }));

    await runRelayPrivacyTurn(h);

    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it('does not resume a pre-existing profile-bearing agentReply session after revocation', async () => {
    const h = replyHarness(undefined, { automaticProfiling: false });

    await h.service.generateAgentReply('user', '12', 'check privacy', 'privacy_revoked_session');

    const fields = h.lastFields();
    expect(fields.sessionId).toBe('privacy_revoked_session_noprofiling');
    expect(fields.sessionId).not.toBe('privacy_revoked_session');
  });

  it('revalidates profile blocks and session on the self-heal upstream attempt', async () => {
    const h = replyHarness(undefined, {
      automaticProfiling: false,
      tasksContext: 'ACTIVE TASKS MARKER',
      profilingSequence: [true, true, true, true, true, false],
    });
    h.post
      .mockImplementationOnce(async () => ({ data: sseStream([]) }))
      .mockImplementationOnce(async () => ({
        data: sseStream([
          { type: 'delta', text: 'retry answer' },
          { type: 'done', costUsd: 0.01, turnCostUsd: 0.01 },
        ]),
      }));

    await runRelayPrivacyTurn(h);

    expect(h.post).toHaveBeenCalledTimes(2);
    const first = fieldsOf(h.post.mock.calls[0][1]);
    const retry = fieldsOf(h.post.mock.calls[1][1]);
    expect(first.systemPrompt).toContain('LIVE USER PROFILE');
    expect(first.systemPrompt).toContain('LIVE BUSINESS PROFILE');
    expect(first.sessionId).toBe('user_12_ru');
    expect(retry.systemPrompt).not.toContain('LIVE USER PROFILE');
    expect(retry.systemPrompt).not.toContain('User profile:');
    expect(retry.systemPrompt).not.toContain('LIVE BUSINESS PROFILE');
    expect(retry.sessionId).toBe('user_12_ru_noprofiling');
    expect(retry.message).toContain('ACTIVE TASKS MARKER');
  });

  it('removes builder copies rather than identical persona fragments on agentReply dispatch', async () => {
    const h = replyHarness(undefined, {
      automaticProfiling: false,
      profilingSequence: [true, true, true, false],
      agentSystemPrompt: PERSONA_WITH_PROFILE_COPIES,
    });

    await h.service.generateAgentReply('user', '12', 'check privacy', 'duplicate_blocks_session');

    expectOnlyPersonaCopies(h.lastFields().systemPrompt);
    expect(h.lastFields().sessionId).toBe('duplicate_blocks_session_noprofiling');
  });

  it('removes builder copies rather than identical persona fragments on relay dispatch', async () => {
    const h = replyHarness(undefined, {
      automaticProfiling: false,
      tasksContext: 'ACTIVE TASKS MARKER',
      profilingSequence: [true, true, true, true, false],
      agentSystemPrompt: PERSONA_WITH_PROFILE_COPIES,
    });

    await runRelayPrivacyTurn(h);

    expect(h.post).toHaveBeenCalledTimes(1);
    expectOnlyPersonaCopies(h.lastFields().systemPrompt);
    expect(h.lastFields().sessionId).toBe('user_12_ru_noprofiling');
    expect(h.lastFields().message).toContain('ACTIVE TASKS MARKER');
  });

  it('removes only builder copies on self-heal when persona contains identical profile blocks', async () => {
    const h = replyHarness(undefined, {
      automaticProfiling: false,
      tasksContext: 'ACTIVE TASKS MARKER',
      profilingSequence: [true, true, true, true, true, false],
      agentSystemPrompt: PERSONA_WITH_PROFILE_COPIES,
    });
    h.post
      .mockImplementationOnce(async () => ({ data: sseStream([]) }))
      .mockImplementationOnce(async () => ({
        data: sseStream([
          { type: 'delta', text: 'retry answer' },
          { type: 'done', costUsd: 0.01, turnCostUsd: 0.01 },
        ]),
      }));

    await runRelayPrivacyTurn(h);

    expect(h.post).toHaveBeenCalledTimes(2);
    const first = fieldsOf(h.post.mock.calls[0][1]);
    const retry = fieldsOf(h.post.mock.calls[1][1]);
    expect(first.systemPrompt).toContain(PERSONA_WITH_PROFILE_COPIES);
    expect(first.systemPrompt.split(PERSONAL_BLOCK)).toHaveLength(3);
    expect(first.systemPrompt.split(BUSINESS_BLOCK)).toHaveLength(3);
    expectOnlyPersonaCopies(retry.systemPrompt);
    expect(retry.sessionId).toBe('user_12_ru_noprofiling');
    expect(retry.message).toContain('ACTIVE TASKS MARKER');
  });

  it.each([
    {
      order: 'personal allowed, then revoked before business rendering',
      profilingSequence: [true, false, false, true, true],
    },
    {
      order: 'personal revoked, then restored before business rendering',
      profilingSequence: [false, true, false, true, true],
    },
  ])('removes exact mixed-consent blocks: $order', async ({ profilingSequence }) => {
    const h = replyHarness(undefined, {
      automaticProfiling: false,
      tasksContext: 'ACTIVE TASKS MARKER',
      profilingSequence,
    });

    await runRelayPrivacyTurn(h);

    const fields = h.lastFields();
    expect(fields.systemPrompt).not.toContain('LIVE USER PROFILE');
    expect(fields.systemPrompt).not.toContain('User profile:');
    expect(fields.systemPrompt).not.toContain('LIVE BUSINESS PROFILE');
    expect(fields.systemPrompt).toContain('LIVE SYSTEM PROMPT');
    expect(fields.message).toContain('ACTIVE TASKS MARKER');
  });

  it('прерванный ответ (done.failed) в основной сессии возвращает charged-вызову обрывок и признак failure', async () => {
    const h = replyHarness([
      { type: 'delta', text: 'legacy partial' },
      { type: 'done', failed: true, costUsd: 0.01, turnCostUsd: 0.01 },
    ]);

    const result = await h.service.generateAgentReplyWithCharge('user', '12', 'inspect @/etc/passwd');
    expect(result).toMatchObject({
      text: 'legacy partial',
      failed: true,
      failReason: 'unknown',
    });
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
