import { ClaudeCliService } from '../common/services/claude-cli.service';
import { AlertBotAi } from './alert-bot.ai';
import { AlertBotOpsServer } from './alert-bot.ops-server';
import { AlertBotTools } from './alert-bot.tools';
import { TurnInput } from './alert-bot.types';

const TICKET = '11111111-2222-4333-8444-555555555555';

describe('AlertBotAi', () => {
  const input: TurnInput = {
    updateId: 1,
    chatId: '100',
    tgUserId: '200',
    adminUserId: 'admin-1',
    questionMessageId: 300,
    question: 'Что происходит?',
    privateChat: true,
  };
  const savedEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    RELAY_FS_SALT: process.env.RELAY_FS_SALT,
    ALERT_BOT_MODEL: process.env.ALERT_BOT_MODEL,
  };
  let claude: { textWithCost: jest.Mock };
  let ops: { url: jest.Mock; consumeToolNames: jest.Mock };
  let tools: { execute: jest.Mock };
  let ai: AlertBotAi;

  beforeEach(() => {
    process.env.JWT_SECRET = 'spec-secret';
    process.env.RELAY_FS_SALT = 'spec-salt';
    process.env.ALERT_BOT_MODEL = 'claude-test';
    claude = { textWithCost: jest.fn().mockResolvedValue({ text: 'Всё спокойно', costUsd: 0.02 }) };
    ops = {
      url: jest.fn().mockReturnValue('http://127.0.0.1:3091/mcp'),
      consumeToolNames: jest.fn().mockReturnValue([]),
    };
    tools = { execute: jest.fn().mockResolvedValue('{"ticket":"#11111111"}') };
    ai = new AlertBotAi(
      claude as unknown as ClaudeCliService,
      ops as unknown as AlertBotOpsServer,
      tools as unknown as AlertBotTools,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('CLI получает только Claude, без встроенных инструментов, и пять разрешённых ops', async () => {
    process.env.JWT_SECRET = 'spec-secret';
    process.env.RELAY_FS_SALT = 'spec-salt';
    process.env.ALERT_BOT_MODEL = 'claude-test';
    claude.textWithCost.mockResolvedValue({ text: 'Всё спокойно', costUsd: 0.02 });
    ops.url.mockReturnValue('http://127.0.0.1:3091/mcp');
    ops.consumeToolNames.mockReturnValue(['alerts', 'health']);
    tools.execute.mockResolvedValue('{"ticket":"#11111111"}');
    const result = await ai.answer({ ...input, question: 'Почему +79012345678?', replyText: 'a@example.com', ticketId: TICKET });
    const [prompt, opts] = claude.textWithCost.mock.calls[0];
    expect(opts.noFallback).toBe(true);
    expect(opts.tools).toBe('');
    expect(opts.model).toBe('claude-test');
    expect(opts.allowedTools.split(',').sort()).toEqual(['mcp__ops__alerts', 'mcp__ops__health', 'mcp__ops__logs', 'mcp__ops__stats', 'mcp__ops__tickets'].sort());
    expect(Object.keys(opts.mcpServers)).toEqual(['ops']);
    expect(opts.mcpServers.ops.url).toBe('http://127.0.0.1:3091/mcp');
    expect(opts.mcpServers.ops.headers.Authorization).toMatch(/^Bearer /);
    expect(prompt).not.toContain('79012345678');
    expect(prompt).not.toContain('a@example.com');
    expect(prompt).toContain('#11111111');
    expect(result).toEqual({ text: 'Всё спокойно', costUsd: 0.02, tools: ['alerts', 'health'] });
  });

  it('журнал вызовов инструментов очищается и после ошибки', async () => {
    claude.textWithCost.mockRejectedValue(Object.assign(new Error('safe'), { kind: 'auth' }));
    await expect(ai.answer(input)).rejects.toMatchObject({ kind: 'auth' });
    expect(ops.consumeToolNames).toHaveBeenCalled();
  });

  it('контекст ограничен тремя парами', async () => {
    await ai.answer({ ...input, history: [{ question: '1', answer: 'a' }, { question: '2', answer: 'b' }, { question: '3', answer: 'c' }, { question: '4', answer: 'd' }] });
    const [prompt] = claude.textWithCost.mock.calls[0];
    expect(prompt).not.toContain('question: 1');
    expect(prompt).toContain('question: 2');
    expect(prompt).toContain('question: 4');
  });
});
