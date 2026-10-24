import { McpController } from './mcp.controller';
import { SUPPORT_NOTE } from '../problem-report/problem-report.service';

const KIRA_ERROR = 'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available.';

const make = (result: any, supportNotified = true) => {
  const tools = { executeTool: jest.fn(async () => result) };
  const problems = { reportToolFailure: jest.fn(() => ({ supportNotified })) };
  const chat = { activeAssistantFor: jest.fn(() => '22') };
  const ctrl = new McpController(tools as any, problems as any, chat as any);
  return { ctrl, tools, problems, chat };
};
const payload = (r: any) => JSON.parse(r.content[0].text);

describe('/mcp: сбой инструмента — в поддержку', () => {
  it('сбой: отправка с ассистентом хода; в результате supportNotified и supportNote; ошибка и isError прежние', async () => {
    const { ctrl, problems, chat, tools } = make({ ok: false, error: KIRA_ERROR });
    const r = await ctrl.callTool('generate_video', { userId: 'u1', mode: 'text2video', prompt: 'тайный промпт' });
    expect(tools.executeTool).toHaveBeenCalledWith('u1', 'generate_video', { mode: 'text2video', prompt: 'тайный промпт' });
    expect(chat.activeAssistantFor).toHaveBeenCalledWith('u1');
    expect(problems.reportToolFailure).toHaveBeenCalledWith({ userId: 'u1', assistantId: '22', tool: 'generate_video', error: KIRA_ERROR });
    expect(r.isError).toBe(true);
    expect(payload(r)).toEqual({ ok: false, error: KIRA_ERROR, supportNotified: true, supportNote: SUPPORT_NOTE });
  });

  // Решение владельца 24.10: в группу — только служебное, аргументы инструмента не уходят.
  it('аргументы инструмента в отправку не попадают', async () => {
    const { ctrl, problems } = make({ ok: false, error: KIRA_ERROR });
    await ctrl.callTool('generate_video', { userId: 'u1', prompt: 'тайный промпт' });
    expect(JSON.stringify(problems.reportToolFailure.mock.calls)).not.toContain('тайный промпт');
  });

  it('сервис сказал «не сбой» — полей нет', async () => {
    const { ctrl } = make({ ok: false, error: 'insufficient_tokens' }, false);
    const p = payload(await ctrl.callTool('generate_image', { userId: 'u1', prompt: 'x' }));
    expect(p.supportNotified).toBeUndefined();
    expect(p.supportNote).toBeUndefined();
  });

  it('успех — в поддержку не ходим', async () => {
    const { ctrl, problems } = make({ ok: true, kind: 'image', imageUrl: 'https://x/y.png', tokensSpent: 5000 });
    const r = await ctrl.callTool('generate_image', { userId: 'u1', prompt: 'x' });
    expect(problems.reportToolFailure).not.toHaveBeenCalled();
    expect(r.isError).toBe(false);
  });

  it('сообщение о сбое упало — ответ инструмента всё равно уходит как был', async () => {
    const { ctrl, problems } = make({ ok: false, error: KIRA_ERROR });
    problems.reportToolFailure.mockImplementation(() => { throw new Error('boom'); });
    const r = await ctrl.callTool('generate_video', { userId: 'u1' });
    expect(payload(r)).toEqual({ ok: false, error: KIRA_ERROR });
    expect(r.isError).toBe(true);
  });

  it('без userId — отказ; инструмент и поддержка не зовутся', async () => {
    const { ctrl, tools, problems } = make({ ok: true });
    const r = await ctrl.callTool('generate_video', { prompt: 'x' });
    expect(r.isError).toBe(true);
    expect(payload(r)).toEqual({ ok: false, error: 'userId argument required' });
    expect(tools.executeTool).not.toHaveBeenCalled();
    expect(problems.reportToolFailure).not.toHaveBeenCalled();
  });
});
