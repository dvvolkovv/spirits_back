import 'reflect-metadata';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';
import * as openPageModule from '../chat/web-page/open-page';

/**
 * open_page — страница по ссылке. На точке продуктов, только в вебе и не в
 * области help: в Telegram у CLI свой WebFetch, а ход группы с посторонними
 * получает одну справку. Пользователь — из подписи токена (по нему считается
 * лимит частоты); в статистику — канал, исход и вид, без адреса и текста.
 */
describe('open_page на точке /webhook/mcp/products', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_FLAG = process.env.CHAT_UPLOADS_ENABLED;
  beforeAll(() => { process.env.JWT_SECRET = 'open-page-spec-secret'; });
  afterAll(() => {
    if (OLD_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = OLD_SECRET;
    if (OLD_FLAG === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
    else process.env.CHAT_UPLOADS_ENABLED = OLD_FLAG;
  });
  beforeEach(() => { delete process.env.CHAT_UPLOADS_ENABLED; });
  afterEach(() => jest.restoreAllMocks());

  const make = () => {
    const tool = { execute: jest.fn(async () => ({ ok: true })) };
    const files = { searchForUser: jest.fn() };
    const problems = { reportFromAssistant: jest.fn() };
    const chat = { activeAssistantFor: jest.fn(() => null) };
    const uploads = { setNote: jest.fn() };
    const events = { track: jest.fn() };
    const ctrl = new ProductsMcpController(tool as any, files as any, problems as any, chat as any, uploads as any, events as any);
    return { ctrl, tool, events };
  };
  const bearer = (channel: 'web' | 'telegram' = 'web', opts: any = {}) =>
    `Bearer ${signProductToolToken('u-owner', channel, opts)}`;
  const PAGE_OK = {
    kind: 'html' as const,
    result: {
      ok: true as const, notice: 'n', url: 'https://example.com/secret-path', status: 200, title: 'Секретный заголовок',
      description: '', truncated: false, text: 'Секретный текст', links: [],
    },
  };

  describe('список инструментов', () => {
    it('веб: open_page после поиска файлов, до сообщения в поддержку; без userId в схеме', () => {
      const { ctrl } = make();
      const tools = ctrl.listTools('web') as any[];
      expect(tools.map((t) => t.name)).toEqual(['manage_product', 'find_files', 'open_page', 'report_problem', 'linkeon_help']);
      const open = tools.find((t) => t.name === 'open_page');
      expect(Object.keys(open.inputSchema.properties).sort()).toEqual(['max_chars', 'url']);
    });

    it('веб с памятью загрузок: open_page после note_file', () => {
      process.env.CHAT_UPLOADS_ENABLED = 'true';
      const { ctrl } = make();
      expect(ctrl.listTools('web').map((t: any) => t.name))
        .toEqual(['manage_product', 'find_files', 'note_file', 'open_page', 'report_problem', 'linkeon_help']);
    });

    it('Telegram и область help: open_page нет', () => {
      const { ctrl } = make();
      expect(ctrl.listTools('telegram').map((t: any) => t.name)).not.toContain('open_page');
      expect(ctrl.listTools('web', { scope: 'help' }).map((t: any) => t.name)).toEqual(['linkeon_help']);
      expect(ctrl.listTools('telegram', { scope: 'help' }).map((t: any) => t.name)).toEqual(['linkeon_help']);
    });

    it('через настоящий MCP-сервер: веб-токен видит open_page, токен Telegram — нет', async () => {
      async function names(b: string) {
        const { ctrl } = make();
        const server = (ctrl as any).makeServer(b);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const client = new Client({ name: 'spec', version: '1.0.0' });
        await client.connect(clientSide);
        const tools = await client.listTools();
        await client.close();
        return tools.tools.map((t: any) => t.name);
      }
      expect(await names(bearer('web'))).toContain('open_page');
      expect(await names(bearer('telegram'))).not.toContain('open_page');
      expect(await names(bearer('web', { scope: 'help' }))).not.toContain('open_page');
    });
  });

  describe('вызов', () => {
    it('пользователь — из токена, userId/channel/turn из аргументов выброшены, язык — из подписи', async () => {
      const spy = jest.spyOn(openPageModule, 'openPage').mockResolvedValue(PAGE_OK);
      const { ctrl, tool } = make();
      const r: any = await ctrl.callTool(
        bearer('web', { lang: 'en' }),
        { url: 'https://example.com/secret-path', max_chars: 5000, userId: '70000000000', channel: 'telegram', turn: 't' },
        'open_page',
      );
      expect(r).toEqual(PAGE_OK.result);
      expect(spy).toHaveBeenCalledTimes(1);
      const [userId, input, deps] = spy.mock.calls[0];
      expect(userId).toBe('u-owner');
      expect(input).toEqual({ url: 'https://example.com/secret-path', max_chars: 5000 });
      expect(deps.lang).toBe('en');
      expect(deps.limiter).toBeInstanceOf(openPageModule.PageRateLimiter);
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('лимит частоты один на точку: все вызовы идут через один и тот же счётчик', async () => {
      const spy = jest.spyOn(openPageModule, 'openPage').mockResolvedValue(PAGE_OK);
      const { ctrl } = make();
      await ctrl.callTool(bearer(), { url: 'https://a.example/' }, 'open_page');
      await ctrl.callTool(bearer(), { url: 'https://b.example/' }, 'open_page');
      expect(spy.mock.calls[0][2].limiter).toBe(spy.mock.calls[1][2].limiter);
    });

    it('событие open_page_call: канал, исход и вид — без адреса, хоста и текста', async () => {
      jest.spyOn(openPageModule, 'openPage')
        .mockResolvedValueOnce(PAGE_OK)
        .mockResolvedValueOnce({ kind: 'unsafe', result: { ok: false, error: 'адрес закрыт' } });
      const { ctrl, events } = make();
      await ctrl.callTool(bearer(), { url: 'https://example.com/secret-path' }, 'open_page');
      await ctrl.callTool(bearer(), { url: 'http://secret-host.example/' }, 'open_page');
      expect(events.track.mock.calls).toEqual([
        ['open_page_call', { userId: 'u-owner', props: { channel: 'web', ok: true, kind: 'html' } }],
        ['open_page_call', { userId: 'u-owner', props: { channel: 'web', ok: false, kind: 'unsafe' } }],
      ]);
      expect(JSON.stringify(events.track.mock.calls)).not.toMatch(/example|secret|Секрет/);
    });

    it('токен Telegram и область help — «Неизвестный инструмент», страница не открывается', async () => {
      const spy = jest.spyOn(openPageModule, 'openPage');
      const { ctrl, events } = make();
      const a: any = await ctrl.callTool(bearer('telegram'), { url: 'https://example.com/' }, 'open_page');
      const b: any = await ctrl.callTool(bearer('web', { scope: 'help' }), { url: 'https://example.com/' }, 'open_page');
      expect(a).toEqual({ ok: false, error: 'Неизвестный инструмент: open_page' });
      expect(b).toEqual({ ok: false, error: 'Неизвестный инструмент: open_page' });
      expect(spy).not.toHaveBeenCalled();
      expect(events.track).not.toHaveBeenCalled();
    });

    // Без подмен: настоящий openPage с настоящим safeGet. Адрес — IP-литерал
    // релея: отказ происходит до сети, по списку наших серверов.
    it('без подмен: адрес нашего релея — отказ, событие unsafe', async () => {
      const { ctrl, events } = make();
      const r: any = await ctrl.callTool(bearer(), { url: 'http://5.101.115.184/' }, 'open_page');
      expect(r.ok).toBe(false);
      expect(r.error).not.toMatch(/5\.101/);
      expect(events.track).toHaveBeenCalledWith('open_page_call', { userId: 'u-owner', props: { channel: 'web', ok: false, kind: 'unsafe' } });
    });
  });
});
