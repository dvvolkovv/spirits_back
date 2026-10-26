import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { UnauthorizedException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import * as jwt from 'jsonwebtoken';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';

describe('точка /mcp/products', () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-product-tool'; });
  afterAll(() => { process.env.JWT_SECRET = OLD; });

  const make = (language?: any) => {
    const calls: any[] = [];
    const tool = {
      execute: jest.fn(async (userId: string, input: any, channel?: string) => {
        calls.push({ userId, input, channel });
        return { ok: true };
      }),
    };
    const files = { searchForUser: jest.fn(async () => ({ ok: true, total: 0, files: [] })) };
    const events = { track: jest.fn() };
    const problems = { reportFromAssistant: jest.fn(async () => ({ ok: true, reported: true, say: 'ok' })) };
    const chat = { activeAssistantFor: jest.fn(() => null) };
    return {
      ctrl: new ProductsMcpController(tool as any, files as any, problems as any, chat as any, events as any, language),
      calls, tool, files, events, problems, chat,
    };
  };

  it('владелец берётся ИЗ ТОКЕНА', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187')}`, { action: 'list' });
    expect(calls[0].userId).toBe('79030169187');
  });

  // Главная защита этой точки. Поле userId в запросе не должно значить НИЧЕГО:
  // иначе возвращается ровно та дыра, из-за которой инструмент не отдали общей
  // точке /mcp (там userId пишет модель — mcp.controller.ts, callTool).
  it('поле userId в запросе игнорируется полностью', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187')}`, { action: 'list', userId: '70000000000' });
    expect(calls[0].userId).toBe('79030169187');
    expect(calls[0].input.userId).toBeUndefined();
  });

  // Канал хода (web/telegram) — из подписи, как и владелец. Правка из
  // Telegram ложится в product_turns с channel='telegram', из веба — 'web'.
  it('канал берётся ИЗ ТОКЕНА: telegram', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187', 'telegram')}`, { action: 'list' });
    expect(calls[0].channel).toBe('telegram');
  });

  it('веб-токен даёт канал web', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187', 'web')}`, { action: 'list' });
    expect(calls[0].channel).toBe('web');
  });

  // Токены релея, выпущенные до появления канала, живут до 30 минут после
  // выката — они обязаны работать и значить «веб».
  it('токен без канала (релей до правки) — канал web', async () => {
    const { ctrl, calls } = make();
    const legacy = jwt.sign({ userId: '79030169187', type: 'product-tool' }, process.env.JWT_SECRET!);
    await ctrl.callTool(`Bearer ${legacy}`, { action: 'list' });
    expect(calls[0].userId).toBe('79030169187');
    expect(calls[0].channel).toBe('web');
  });

  // Тот же приём, что с userId: поле пишет модель, и значить оно не должно ничего.
  it('поле channel в запросе не меняет канал и не доезжает до инструмента', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187', 'web')}`, { action: 'list', channel: 'telegram' });
    expect(calls[0].channel).toBe('web');
    expect(calls[0].input.channel).toBeUndefined();
  });

  it('без токена — отказ, инструмент не зовётся', async () => {
    const { ctrl, tool } = make();
    await expect(ctrl.callTool(undefined, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('чужая подпись — отказ', async () => {
    const { ctrl, tool } = make();
    const alien = jwt.sign({ userId: '79030169187', type: 'product-tool' }, 'not-our-secret');
    await expect(ctrl.callTool(`Bearer ${alien}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('access-токен пользователя сюда не пускают', async () => {
    const { ctrl, tool } = make();
    const access = jwt.sign({ userId: '79030169187', type: 'access' }, process.env.JWT_SECRET!);
    await expect(ctrl.callTool(`Bearer ${access}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('общий MCP_SECRET здесь не работает', async () => {
    const { ctrl, tool } = make();
    process.env.MCP_SECRET = 'shared-secret';
    await expect(ctrl.callTool('Bearer shared-secret', { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('просроченный токен — отказ', async () => {
    const { ctrl, tool } = make();
    const stale = jwt.sign({ userId: '79030169187', type: 'product-tool' }, process.env.JWT_SECRET!, { expiresIn: -60 });
    await expect(ctrl.callTool(`Bearer ${stale}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('веб: продукты, поиск файлов, сообщение в поддержку и справка; ни у одного нет аргумента userId', () => {
    const { ctrl } = make();
    const tools = ctrl.listTools('web');
    expect(tools.map((t: any) => t.name)).toEqual(['manage_product', 'find_files', 'report_problem', 'linkeon_help']);
    for (const t of tools as any[]) expect(Object.keys(t.inputSchema.properties)).not.toContain('userId');
  });

  it('Telegram: продукты, сообщение в поддержку и справка — поиск файлов в боте не включён', () => {
    const { ctrl } = make();
    expect(ctrl.listTools('telegram').map((t: any) => t.name)).toEqual(['manage_product', 'report_problem', 'linkeon_help']);
  });

  it('find_files: владелец из токена, userId из запроса выбрасывается', async () => {
    const { ctrl, files, tool } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187')}`, { query: 'договор', userId: '70000000000' }, 'find_files');
    expect(files.searchForUser).toHaveBeenCalledWith('79030169187', expect.objectContaining({ query: 'договор' }));
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('find_files с токеном Telegram — отказ, поиск не зовётся', async () => {
    const { ctrl, files, tool } = make();
    const r: any = await ctrl.callTool(`Bearer ${signProductToolToken('79030169187', 'telegram')}`, { query: 'x' }, 'find_files');
    expect(r.ok).toBe(false);
    expect(files.searchForUser).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('незнакомое имя — отказ, ничего не зовётся', async () => {
    const { ctrl, files, tool } = make();
    const r: any = await ctrl.callTool(`Bearer ${signProductToolToken('79030169187')}`, {}, 'rm_rf');
    expect(r.ok).toBe(false);
    expect(files.searchForUser).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  // Область help выдаётся ходам Telegram-группы с посторонними: справка ничего
  // личного не раскрывает, а продукты и файлы владельца там трогать нельзя.
  describe('справка linkeon_help', () => {
    const helpBearer = (opts: any = {}) => `Bearer ${signProductToolToken('u-owner', 'telegram', { scope: 'help', ...opts })}`;

    it('по токену help показывается только справка', () => {
      const { ctrl } = make();
      expect(ctrl.listTools('telegram', { scope: 'help' }).map((t: any) => t.name)).toEqual(['linkeon_help']);
    });

    it('по токену help продукты и поиск файлов — отказ, ничего не зовётся', async () => {
      const { ctrl, tool, files } = make();
      const a: any = await ctrl.callTool(helpBearer(), { action: 'list' }, 'manage_product');
      const b: any = await ctrl.callTool(helpBearer(), { query: 'x' }, 'find_files');
      expect(a.ok).toBe(false);
      expect(b.ok).toBe(false);
      expect(tool.execute).not.toHaveBeenCalled();
      expect(files.searchForUser).not.toHaveBeenCalled();
    });

    // report_problem — тоже не входит в область help (toolsFor возвращает для
    // неё ровно [help]): посторонний в группе Telegram не должен слать
    // обращения в поддержку от имени владельца бота.
    it('по токену help report_problem — отказ «Неизвестный инструмент», reportFromAssistant не зовётся', async () => {
      const { ctrl, problems } = make();
      const r: any = await ctrl.callTool(helpBearer(), { assistant: 'Кира', kind: 'my_failure', summary: 'x' }, 'report_problem');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Неизвестный инструмент/);
      expect(problems.reportFromAssistant).not.toHaveBeenCalled();
    });

    it('статья — на языке из подписи токена', async () => {
      const { ctrl } = make();
      const en: any = await ctrl.callTool(`Bearer ${signProductToolToken('u-test', 'web', { lang: 'en', client: 'web' })}`, { topics: ['products'] }, 'linkeon_help');
      const ru: any = await ctrl.callTool(`Bearer ${signProductToolToken('u-test', 'web', { lang: 'ru', client: 'web' })}`, { topics: ['products'] }, 'linkeon_help');
      expect(en.ok).toBe(true);
      expect(en.articles[0].text).toContain('«Studio»');
      expect(ru.articles[0].text).toContain('«Студия»');
    });

    it('токен без языка (выпущен до справки) — язык из профиля', async () => {
      const language = { resolveUserLanguage: jest.fn(async () => 'en') };
      const { ctrl } = make(language);
      const r: any = await ctrl.callTool(`Bearer ${signProductToolToken('u-test')}`, { topics: ['products'] }, 'linkeon_help');
      expect(language.resolveUserLanguage).toHaveBeenCalledWith('u-test');
      expect(r.articles[0].text).toContain('«Studio»');
    });

    it('стор: темы о деньгах в схеме не предлагаются', () => {
      const { ctrl } = make();
      const help: any = ctrl.listTools('web', { client: 'store' }).find((t: any) => t.name === 'linkeon_help');
      expect(help.inputSchema.properties.topics.items.enum).not.toContain('payments');
      expect(help.inputSchema.properties.topics.items.enum).toContain('products');
    });

    it('вызов пишется в статистику — темы, канал, клиент, без текста разговора', async () => {
      const { ctrl, events } = make();
      await ctrl.callTool(helpBearer({ lang: 'ru', client: 'telegram', agent: 'staff' }), { topics: ['studio-bots'] }, 'linkeon_help');
      expect(events.track).toHaveBeenCalledWith('linkeon_help_call', {
        userId: 'u-owner',
        props: { channel: 'telegram', client: 'telegram', lang: 'ru', scope: 'help', agent: 'staff', topics: ['studio-bots'], index: false },
      });
    });

    it('userId в аргументах справки ни на что не влияет', async () => {
      const { ctrl, events } = make();
      await ctrl.callTool(`Bearer ${signProductToolToken('u-test', 'web', { lang: 'ru' })}`, { topics: ['chat'], userId: 'u-other' }, 'linkeon_help');
      expect(events.track.mock.calls[0][1].userId).toBe('u-test');
    });
  });

  // makeServer собирает tools/list из claims токена (channel, client, scope),
  // а не из аргументов запроса — через настоящий MCP-клиент, как и в
  // products-mcp.report-problem.spec.ts: на одних моках откат к ctrl.listTools()
  // с другими параметрами остался бы зелёным.
  describe('makeServer: область и клиент из токена идут в tools/list', () => {
    async function listViaRealServer(bearer: string) {
      const { ctrl } = make();
      const server = (ctrl as any).makeServer(bearer);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'spec', version: '1.0.0' });
      await client.connect(clientSide);
      const tools = await client.listTools();
      await client.close();
      return tools.tools.map((t: any) => t.name);
    }

    it('токен с областью help — сервер отдаёт только linkeon_help', async () => {
      const bearer = `Bearer ${signProductToolToken('u-owner', 'telegram', { scope: 'help' })}`;
      const names = await listViaRealServer(bearer);
      const { ctrl } = make();
      expect(names).toEqual(ctrl.listTools('telegram', { scope: 'help' }).map((t: any) => t.name));
      expect(names).toEqual(['linkeon_help']);
    });

    it('токен без области, канал web — полный набор, как у ctrl.listTools(\'web\')', async () => {
      const bearer = `Bearer ${signProductToolToken('u-owner', 'web')}`;
      const names = await listViaRealServer(bearer);
      const { ctrl } = make();
      expect(names).toEqual(ctrl.listTools('web').map((t: any) => t.name));
    });

    it('клиент store из токена — в схеме справки нет тем о деньгах', async () => {
      const bearer = `Bearer ${signProductToolToken('u-owner', 'web', { client: 'store' })}`;
      const { ctrl } = make();
      const server = (ctrl as any).makeServer(bearer);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'spec', version: '1.0.0' });
      await client.connect(clientSide);
      const tools = await client.listTools();
      await client.close();
      const help: any = tools.tools.find((t: any) => t.name === 'linkeon_help');
      expect(help.inputSchema.properties.topics.items.enum).not.toContain('payments');
    });
  });
});

/**
 * АДРЕС ТОЧКИ ЗАВИСИТ ОТ ДВУХ ФАЙЛОВ СРАЗУ, и ни один из них по отдельности
 * правды не говорит.
 *
 * В main.ts стоит `setGlobalPrefix('webhook', { exclude: [{ path: 'mcp' }] })`.
 * Исключение написано как ТОЧНЫЙ путь `mcp`, а не как префикс `mcp/(.*)`,
 * поэтому из-под глобального префикса выходит только сама `/mcp` — а подпуть
 * `/mcp/products` остаётся под ним и живёт по адресу `/webhook/mcp/products`.
 *
 * Измерено живым приложением: `POST /mcp/products` отдаёт 404, `POST
 * /webhook/mcp/products` — 200 со списком инструментов.
 *
 * Почему адрес оставлен таким, а не «починен» правкой main.ts: на проде
 * nginx проксирует `location /mcp` префиксом, а на тестовом стенде такого
 * блока НЕТ ВОВСЕ — там `/mcp/products` ушёл бы в SPA-фолбэк и вернул 200 с
 * HTML. Зелёная проверка при неработающей точке — ровно тот тихий отказ,
 * которым этот проект уже наелся. `/webhook/*` работает на обеих средах
 * сегодня и ничего в nginx не требует.
 *
 * Цена разъезда молчаливая с обеих сторон: релей запущен со
 * `--strict-mcp-config`, недоступный сервер он просто не поднимет, и ассистент
 * скажет «не умею» — без ошибки в логе и без красного теста.
 */
describe('адрес точки', () => {
  const mainSrc = () => fs.readFileSync(path.join(__dirname, '../main.ts'), 'utf8');

  it('точка стоит ровно там, куда настроен релей', () => {
    const ctrlPath = Reflect.getMetadata(PATH_METADATA, ProductsMcpController) ?? '';
    const methodPath = Reflect.getMetadata(PATH_METADATA, ProductsMcpController.prototype.post) ?? '';
    const verb = Reflect.getMetadata(METHOD_METADATA, ProductsMcpController.prototype.post);
    const full = `/${['webhook', ctrlPath, methodPath].join('/')}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    // Глагол склеен с путём: он лежит под ДРУГИМ ключом метаданных, и сторож,
    // читающий только путь, переживает замену @Post на @Get целиком.
    expect(`${RequestMethod[verb]} ${full}`).toBe('POST /webhook/mcp/products');
  });

  it('исключение в main.ts не расширено до подпутей', () => {
    const src = mainSrc();
    // Появление `mcp/(.*)` или `mcp/*` в списке исключений УВОДИТ точку на
    // /mcp/products — то есть на адрес, которого нет в nginx тестового стенда.
    expect(src).toMatch(/exclude:\s*\[\s*\{\s*path:\s*'mcp'/);
    expect(src).not.toMatch(/path:\s*'mcp\/[^']*'/);
  });
});
