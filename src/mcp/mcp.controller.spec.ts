import * as jwt from 'jsonwebtoken';
import { UnauthorizedException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpController } from './mcp.controller';
import { CHAT_TOOLS } from '../chat/chat-tools';
import { signLinkeonToolToken } from './linkeon-tool.token';
import { signProductToolToken } from '../products/product-tool.token';

/**
 * Точка инструментов Linkeon (mcp__linkeon__*): пользователь — из подписи
 * токена хода, а не из аргумента, который пишет модель. Спека:
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 */
const OLD = { jwt: process.env.JWT_SECRET, mcp: process.env.MCP_SECRET };
beforeAll(() => {
  process.env.JWT_SECRET = 'mcp-controller-spec';
  delete process.env.MCP_SECRET;
});
afterAll(() => {
  if (OLD.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD.jwt;
  if (OLD.mcp === undefined) delete process.env.MCP_SECRET; else process.env.MCP_SECRET = OLD.mcp;
});
afterEach(() => {
  delete process.env.MCP_SECRET;
  jest.restoreAllMocks();
});

const bearer = (userId: string) => `Bearer ${signLinkeonToolToken(userId)}`;

function make() {
  const tools = { executeTool: jest.fn(async (..._a: any[]) => ({ ok: true, kind: 'image', imageUrl: 'https://x/y.png' })) };
  const problems = { reportToolFailure: jest.fn(() => ({ supportNotified: false })) };
  const chat = { activeAssistantFor: jest.fn(() => null) };
  const ctrl = new McpController(tools as any, problems as any, chat as any);
  jest.spyOn((ctrl as any).logger, 'log').mockImplementation(() => undefined);
  return { ctrl, tools };
}

describe('точка инструментов Linkeon: пользователь из токена хода', () => {
  it('пользователь — из подписи токена', async () => {
    const { ctrl, tools } = make();
    await ctrl.callTool(bearer('u-owner'), 'generate_image', { prompt: 'кот' });
    expect(tools.executeTool).toHaveBeenCalledWith('u-owner', 'generate_image', { prompt: 'кот' });
  });

  // Главная защита точки: поле userId, которое пишет модель, не значит ничего
  // и до инструмента не доезжает (как в products-mcp.controller.ts).
  it('userId в аргументах ничего не значит и до инструмента не доезжает', async () => {
    const { ctrl, tools } = make();
    await ctrl.callTool(bearer('u-owner'), 'generate_image', { prompt: 'кот', userId: '70000000000' });
    expect(tools.executeTool).toHaveBeenCalledWith('u-owner', 'generate_image', { prompt: 'кот' });
  });

  it('без Bearer — 401, инструмент не зовётся', async () => {
    const { ctrl, tools } = make();
    await expect(ctrl.callTool(undefined, 'generate_image', { userId: 'u-1', prompt: 'x' })).rejects.toThrow(UnauthorizedException);
    expect(tools.executeTool).not.toHaveBeenCalled();
  });

  it('чужая подпись — 401', async () => {
    const { ctrl, tools } = make();
    const alien = jwt.sign({ userId: 'u-1', type: 'linkeon-tool' }, 'not-our-secret');
    await expect(ctrl.callTool(`Bearer ${alien}`, 'generate_image', { prompt: 'x' })).rejects.toThrow(UnauthorizedException);
    expect(tools.executeTool).not.toHaveBeenCalled();
  });

  it('access-токен пользователя — 401', async () => {
    const { ctrl, tools } = make();
    const access = jwt.sign({ userId: 'u-1', type: 'access' }, process.env.JWT_SECRET!);
    await expect(ctrl.callTool(`Bearer ${access}`, 'generate_image', { prompt: 'x' })).rejects.toThrow(UnauthorizedException);
    expect(tools.executeTool).not.toHaveBeenCalled();
  });

  it('токен продуктов — 401', async () => {
    const { ctrl, tools } = make();
    await expect(ctrl.callTool(`Bearer ${signProductToolToken('u-1')}`, 'generate_image', { prompt: 'x' })).rejects.toThrow(UnauthorizedException);
    expect(tools.executeTool).not.toHaveBeenCalled();
  });

  it('tools/list по токену: все инструменты CHAT_TOOLS, ни в одном нет userId и номера-примера', () => {
    const list = make().ctrl.listTools({ kind: 'token', userId: 'u-1' });
    expect(list.map((t) => t.name)).toEqual(CHAT_TOOLS.map((t) => t.name));
    for (const t of list) {
      expect(Object.keys(t.inputSchema.properties)).not.toContain('userId');
      expect(t.inputSchema.required).not.toContain('userId');
    }
    expect(JSON.stringify(list)).not.toContain('79030169187');
  });

  it('через настоящий MCP-сервер по токену: в схемах нет userId, вызов — от пользователя подписи', async () => {
    const { ctrl, tools } = make();
    const server = (ctrl as any).makeServer(bearer('u-owner'));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    const listed = await client.listTools();
    expect(listed.tools.length).toBe(CHAT_TOOLS.length);
    for (const t of listed.tools) expect(Object.keys((t.inputSchema as any).properties ?? {})).not.toContain('userId');
    await client.callTool({ name: 'generate_image', arguments: { prompt: 'кот', userId: '70000000000' } });
    expect(tools.executeTool).toHaveBeenCalledWith('u-owner', 'generate_image', { prompt: 'кот' });
    await client.close();
  });

  // Ревью 26.10.2026: на пути по токену в лог — короткая строка-счётчик,
  // без значений (ни пользователя из подписи, ни чужого userId из аргумента).
  it('userId в аргументах на пути по токену — строка-счётчик без значений', async () => {
    const { ctrl, tools } = make();
    const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
    await ctrl.callTool(bearer('u-owner'), 'generate_image', { prompt: 'x', userId: '70000000000' });
    expect(warn).toHaveBeenCalledWith('mcp: userId в аргументах проигнорирован, tool=generate_image');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('70000000000');
    expect(logged).not.toContain('u-owner');
    expect(tools.executeTool).toHaveBeenCalledWith('u-owner', 'generate_image', { prompt: 'x' });
  });

  it('без userId в аргументах на пути по токену — строка-счётчик не пишется', async () => {
    const { ctrl } = make();
    const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
    await ctrl.callTool(bearer('u-owner'), 'generate_image', { prompt: 'x' });
    expect(warn).not.toHaveBeenCalled();
  });

  // Ревью 26.10.2026: путь по токену не зовёт тот же logger.warn, что
  // переходный путь по общему секрету — иначе по логу нельзя будет отличить,
  // кто ещё зовёт точку общим секретом (шаг 3 выката).
  it('путь по токену не пишет строку «вызов по общему секрету»', async () => {
    const { ctrl } = make();
    const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
    await ctrl.callTool(bearer('u-owner'), 'generate_image', { prompt: 'x' });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('общему секрету'));
  });

  // Ревью 26.10.2026: «смешивание» — MCP_SECRET задан (переходный путь ещё не
  // снят), но в заголовке — токен хода, а не общий секрет. Пользователь — из
  // подписи, чужой args.userId игнорируется, как и без MCP_SECRET.
  it('смешивание: MCP_SECRET задан, но в заголовке — токен хода; args.userId — чужой', async () => {
    process.env.MCP_SECRET = 'shared-spec';
    try {
      const { ctrl, tools } = make();
      await ctrl.callTool(bearer('u-owner'), 'generate_image', { prompt: 'кот', userId: '70000000000' });
      expect(tools.executeTool).toHaveBeenCalledWith('u-owner', 'generate_image', { prompt: 'кот' });
    } finally {
      delete process.env.MCP_SECRET;
    }
  });

  describe('переходный путь: общий MCP_SECRET', () => {
    const SHARED = 'Bearer shared-spec';
    beforeEach(() => { process.env.MCP_SECRET = 'shared-spec'; });

    it('пользователь — из args.userId; в лог — строка без пользователя и аргументов', async () => {
      const { ctrl, tools } = make();
      const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
      await ctrl.callTool(SHARED, 'generate_image', { userId: '70000000000', prompt: 'тайный промпт' });
      expect(tools.executeTool).toHaveBeenCalledWith('70000000000', 'generate_image', { prompt: 'тайный промпт' });
      expect(warn).toHaveBeenCalledWith('mcp: вызов по общему секрету (переходный путь), tool=generate_image');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('70000000000');
      expect(logged).not.toContain('тайный промпт');
    });

    it('без args.userId — отказ, инструмент не зовётся', async () => {
      const { ctrl, tools } = make();
      jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
      const r: any = await ctrl.callTool(SHARED, 'generate_image', { prompt: 'x' });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text)).toEqual({ ok: false, error: 'userId argument required' });
      expect(tools.executeTool).not.toHaveBeenCalled();
    });

    // Прежний релей пишет пользователя в аргумент по схеме: без поля в схеме
    // между выкатом бэка и выкатом релея модель могла бы перестать его слать.
    it('tools/list по общему секрету — прежняя схема с обязательным userId, но без номера-примера', () => {
      const list = make().ctrl.listTools({ kind: 'shared' });
      for (const t of list) {
        expect(t.inputSchema.required[0]).toBe('userId');
        expect(t.inputSchema.properties).toHaveProperty('userId');
      }
      expect(JSON.stringify(list)).not.toContain('79030169187');
    });

    it('неверный секрет — 401', async () => {
      const { ctrl, tools } = make();
      await expect(ctrl.callTool('Bearer not-the-secret', 'generate_image', { userId: 'u-1' })).rejects.toThrow(UnauthorizedException);
      expect(tools.executeTool).not.toHaveBeenCalled();
    });

    // Ревью 26.10.2026: сравнение — timingSafeEqual над SHA-256 обеих строк,
    // а не над самими строками: у node:crypto timingSafeEqual буферы разной
    // длины роняют сравнение исключением (RangeError), а не честным «не равны».
    it('секрет неправильной длины — тоже 401, а не исключение', async () => {
      const { ctrl, tools } = make();
      await expect(ctrl.callTool('Bearer x', 'generate_image', { userId: 'u-1' })).rejects.toThrow(UnauthorizedException);
      await expect(
        ctrl.callTool(`Bearer ${'shared-spec'.repeat(5)}`, 'generate_image', { userId: 'u-1' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(tools.executeTool).not.toHaveBeenCalled();
    });

    it('MCP_SECRET не задан — пустой Bearer не проходит', async () => {
      delete process.env.MCP_SECRET;
      const { ctrl, tools } = make();
      await expect(ctrl.callTool('Bearer ', 'generate_image', { userId: 'u-1' })).rejects.toThrow(UnauthorizedException);
      expect(tools.executeTool).not.toHaveBeenCalled();
    });
  });
});
