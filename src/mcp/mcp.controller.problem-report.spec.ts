import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpController } from './mcp.controller';
import { SUPPORT_NOTE } from '../problem-report/problem-report.service';
import { signLinkeonToolToken } from './linkeon-tool.token';

const KIRA_ERROR = 'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available.';

const OLD_SECRET = process.env.JWT_SECRET;
beforeAll(() => { process.env.JWT_SECRET = 'mcp-problem-report-spec'; });
afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_SECRET;
});

/** Bearer, с которым релей зовёт точку: токен хода, пользователь — в подписи. */
const bearer = (userId: string) => `Bearer ${signLinkeonToolToken(userId)}`;

const make = (result: any, supportNotified = true) => {
  const tools = { executeTool: jest.fn(async (..._a: any[]) => result) };
  const problems = { reportToolFailure: jest.fn((..._a: any[]) => ({ supportNotified })) };
  const chat = { activeAssistantFor: jest.fn(() => '22') };
  const ctrl = new McpController(tools as any, problems as any, chat as any);
  return { ctrl, tools, problems, chat };
};
const payload = (r: any) => JSON.parse(r.content[0].text);

describe('точка инструментов Linkeon: сбой инструмента — в поддержку', () => {
  it('сбой: отправка с ассистентом хода; в результате supportNotified и supportNote; ошибка и isError прежние', async () => {
    const result = { ok: false, error: KIRA_ERROR };
    const { ctrl, problems, chat, tools } = make(result);
    const r = await ctrl.callTool(bearer('u1'), 'generate_video', { mode: 'text2video', prompt: 'тайный промпт' });
    expect(tools.executeTool).toHaveBeenCalledWith('u1', 'generate_video', { mode: 'text2video', prompt: 'тайный промпт' });
    expect(chat.activeAssistantFor).toHaveBeenCalledWith('u1');
    expect(problems.reportToolFailure).toHaveBeenCalledWith({ userId: 'u1', assistantId: '22', tool: 'generate_video', error: KIRA_ERROR });
    expect(r.isError).toBe(true);
    expect(payload(r)).toEqual({ ok: false, error: KIRA_ERROR, supportNotified: true, supportNote: SUPPORT_NOTE });
    // Копия, а не правка: если ответ инструмента когда-нибудь закешируют, поля не протекут в чужой вызов.
    expect(result).toEqual({ ok: false, error: KIRA_ERROR });
  });

  it('через настоящий MCP-сервер: tools/call доходит до callTool и несёт supportNotified', async () => {
    const { ctrl } = make({ ok: false, error: KIRA_ERROR });
    const server = (ctrl as any).makeServer(bearer('u1'));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    const r: any = await client.callTool({ name: 'generate_video', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: false, error: KIRA_ERROR, supportNotified: true, supportNote: SUPPORT_NOTE });
    await client.close();
  });

  // Решение владельца 24.10: в группу — только служебное, аргументы инструмента не уходят.
  it('аргументы инструмента в отправку не попадают', async () => {
    const { ctrl, problems } = make({ ok: false, error: KIRA_ERROR });
    await ctrl.callTool(bearer('u1'), 'generate_video', { prompt: 'тайный промпт' });
    expect(JSON.stringify(problems.reportToolFailure.mock.calls)).not.toContain('тайный промпт');
  });

  it('сервис сказал «не сбой» — полей нет', async () => {
    const { ctrl } = make({ ok: false, error: 'insufficient_tokens' }, false);
    const p = payload(await ctrl.callTool(bearer('u1'), 'generate_image', { prompt: 'x' }));
    expect(p.supportNotified).toBeUndefined();
    expect(p.supportNote).toBeUndefined();
  });

  it('успех — в поддержку не ходим', async () => {
    const { ctrl, problems } = make({ ok: true, kind: 'image', imageUrl: 'https://x/y.png', tokensSpent: 5000 });
    const r = await ctrl.callTool(bearer('u1'), 'generate_image', { prompt: 'x' });
    expect(problems.reportToolFailure).not.toHaveBeenCalled();
    expect(r.isError).toBe(false);
  });

  it('сообщение о сбое упало — ответ инструмента всё равно уходит как был', async () => {
    const { ctrl, problems } = make({ ok: false, error: KIRA_ERROR });
    problems.reportToolFailure.mockImplementation(() => { throw new Error('boom'); });
    const r = await ctrl.callTool(bearer('u1'), 'generate_video', {});
    expect(payload(r)).toEqual({ ok: false, error: KIRA_ERROR });
    expect(r.isError).toBe(true);
  });

  it('общий секрет без userId — отказ; инструмент и поддержка не зовутся', async () => {
    process.env.MCP_SECRET = 'shared-problem-spec';
    try {
      const { ctrl, tools, problems } = make({ ok: true });
      jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
      const r = await ctrl.callTool('Bearer shared-problem-spec', 'generate_video', { prompt: 'x' });
      expect(r.isError).toBe(true);
      expect(payload(r)).toEqual({ ok: false, error: 'userId argument required' });
      expect(tools.executeTool).not.toHaveBeenCalled();
      expect(problems.reportToolFailure).not.toHaveBeenCalled();
    } finally {
      delete process.env.MCP_SECRET;
      jest.restoreAllMocks();
    }
  });
});
