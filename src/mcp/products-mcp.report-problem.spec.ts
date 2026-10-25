import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';

process.env.JWT_SECRET = 'report-problem-spec';

const make = (assistantId: string | null = '22') => {
  const tool = { execute: jest.fn(async () => ({ ok: true })) };
  const files = { searchForUser: jest.fn(async () => ({ ok: true, total: 0, files: [] })) };
  const problems = { reportFromAssistant: jest.fn(async (): Promise<any> => ({ ok: true, reported: true, say: 'Передано' })) };
  const chat = { activeAssistantFor: jest.fn(() => assistantId) };
  const ctrl = new ProductsMcpController(tool as any, files as any, problems as any, chat as any);
  return { ctrl, tool, files, problems, chat };
};

describe('report_problem на точке продуктов', () => {
  it('пользователь и канал — из токена, ассистент — из хода; userId/channel из аргументов не значат ничего', async () => {
    const { ctrl, problems, chat, tool, files } = make('22');
    const r: any = await ctrl.callTool(
      `Bearer ${signProductToolToken('u-1', 'web')}`,
      { assistant: 'Кира', kind: 'my_failure', summary: 'LibreOffice падает', userId: 'чужой', channel: 'telegram' },
      'report_problem',
    );
    expect(r).toEqual({ ok: true, reported: true, say: 'Передано' });
    expect(chat.activeAssistantFor).toHaveBeenCalledWith('u-1');
    expect(problems.reportFromAssistant).toHaveBeenCalledWith({
      userId: 'u-1', channel: 'web', assistantId: '22',
      assistantArg: 'Кира', kind: 'my_failure', summary: 'LibreOffice падает',
    });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(files.searchForUser).not.toHaveBeenCalled();
  });

  // У TG-бота хода в ChatService нет; веб-ход того же человека подписал бы сообщение чужим именем.
  it('Telegram: ход не берётся даже если идёт веб-ход — assistantId null', async () => {
    const { ctrl, problems, chat } = make('22');
    await ctrl.callTool(
      `Bearer ${signProductToolToken('u-1', 'telegram')}`,
      { assistant: 'Райя', kind: 'user_report', summary: 'не проходит оплата' },
      'report_problem',
    );
    expect(chat.activeAssistantFor).not.toHaveBeenCalled();
    expect(problems.reportFromAssistant).toHaveBeenCalledWith(expect.objectContaining({ channel: 'telegram', assistantId: null, assistantArg: 'Райя' }));
  });

  it('отказ сервиса доходит до модели как есть', async () => {
    const { ctrl, problems } = make();
    problems.reportFromAssistant.mockResolvedValueOnce({ ok: false, error: 'rate_limited', say: 'Много' });
    const r: any = await ctrl.callTool(`Bearer ${signProductToolToken('u-1')}`, { assistant: 'Кира', kind: 'my_failure', summary: 'x' }, 'report_problem');
    expect(r).toEqual({ ok: false, error: 'rate_limited', say: 'Много' });
  });

  it('другие инструменты точки report_problem не задевают', async () => {
    const { ctrl, problems, tool } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('u-1')}`, { action: 'list' }, 'manage_product');
    expect(tool.execute).toHaveBeenCalled();
    expect(problems.reportFromAssistant).not.toHaveBeenCalled();
  });

  // Связка makeServer → callTool через настоящий MCP-клиент: откат делегирования
  // в tools/call тихо убил бы путь А и путь Б, оставаясь зелёным на моках.
  it('через настоящий MCP-сервер: report_problem виден в списке и доходит до reportFromAssistant', async () => {
    const { ctrl } = make();
    const server = (ctrl as any).makeServer(`Bearer ${signProductToolToken('u-1', 'web')}`);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    const tools = await client.listTools();
    expect(tools.tools.map((t: any) => t.name)).toContain('report_problem');
    const r: any = await client.callTool({ name: 'report_problem', arguments: { assistant: 'Кира', kind: 'my_failure', summary: 'x' } });
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, reported: true, say: 'Передано' });
    await client.close();
  });
});
