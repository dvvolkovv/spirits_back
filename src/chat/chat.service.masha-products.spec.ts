import { ChatService } from './chat.service';
import { verifyProductToolToken } from '../products/product-tool.token';
import { PRODUCTS_CLI_PROMPT } from '../products/products-cli-tool';
import { PRODUCT_TOOL_WAIT_MS } from '../common/relay-budget';
import { LANGUAGE_REPLY_LINE } from '../common/services/language.service';

/**
 * Маша (agent.id === 3) идёт не через релей, а локальным claude CLI — и до
 * этой правки инструмента продуктов у неё не было вовсе: веб-ассистенты его
 * получали через релей, а Маша на просьбу «поправь сайт» могла только
 * рассказать, что не умеет.
 *
 * Решение владельца (26.09.2026): в вебе инструмент у Маши есть ВСЕГДА —
 * пользователь веба владеет своими продуктами. Канал правки — web.
 */

const USER = '79030169187';

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: 100000 }] };
      if (sql.includes('FROM agents a')) {
        return {
          rows: [
            { name: 'Маша', display_name: 'Маша', description: 'психолог', system_prompt: '' },
            { name: 'Роман', display_name: 'Роман', description: 'бизнес', system_prompt: '' },
          ],
        };
      }
      return { rows: [] };
    }),
  };
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'У вас один продукт — сайт «Цветы».', costUsd: 0.01 })),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => '') };
  const svc = new ChatService(
    pg as any,
    undefined as any, // neo4j
    undefined as any, // kling
    {} as any, // tools
    claudeCli as any,
    language as any,
    balanceCtx as any,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 3, name: 'Маша', description: 'психолог', system_prompt: 'Ты Маша.', category: 'personal',
  });
  // Запись истории и списание — после ответа, в setImmediate; здесь не проверяются.
  jest.spyOn(svc as any, 'saveChatHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'addTokenTask').mockResolvedValue(undefined);
  return { svc, claudeCli };
}

function makeRes() {
  const writes: string[] = [];
  const res: any = {
    status: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { writes.push(s); return true; }),
    end: jest.fn(),
    json: jest.fn(),
  };
  return { res, writes };
}

async function runMasha(message = 'Покажи мои продукты') {
  const { svc, claudeCli } = makeService();
  const { res, writes } = makeRes();
  await svc.streamChat(USER, message, '3', `${USER}_3`, 'Имя: Дмитрий', res);
  // Хвост хода (история, списание) уходит в setImmediate — дать ему отработать.
  await new Promise((r) => setImmediate(r));
  expect(claudeCli.textWithCost).toHaveBeenCalledTimes(1);
  const opts = claudeCli.textWithCost.mock.calls[0][1];
  return { opts, writes };
}

describe('Маша в вебе: инструмент продуктов', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_PORT = process.env.PORT;
  const OLD_DS = process.env.DEEPSEEK_API_KEY;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-product-tool';
    delete process.env.PORT;
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD_SECRET;
    if (OLD_PORT === undefined) delete process.env.PORT; else process.env.PORT = OLD_PORT;
    if (OLD_DS === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = OLD_DS;
  });

  it('CLI Маши получает MCP-сервер продуктов по loopback', async () => {
    const { opts } = await runMasha();
    expect(opts.mcpServers?.products?.type).toBe('http');
    expect(opts.mcpServers.products.url).toBe('http://127.0.0.1:3001/webhook/mcp/products');
  });

  it('токен — этого пользователя и канала web', async () => {
    const { opts } = await runMasha();
    const bearer = String(opts.mcpServers.products.headers?.Authorization ?? '');
    expect(bearer).toMatch(/^Bearer /);
    expect(verifyProductToolToken(bearer.replace(/^Bearer /, ''))).toEqual({ userId: USER, channel: 'web' });
  });

  it('автоодобрен ровно инструмент продуктов, встроенные тулы не включаются', async () => {
    const { opts } = await runMasha();
    expect(opts.allowedTools).toBe('mcp__products__manage_product');
    // tools не задан — сервис оставит `--tools ""`: у Маши нет ни Read, ни Bash.
    expect(opts.tools === undefined || opts.tools === '').toBe(true);
  });

  it('блок про продукты — в системном промпте, а требование языка остаётся последним', async () => {
    const { opts } = await runMasha();
    const system = String(opts.system);
    expect(system).toContain(PRODUCTS_CLI_PROMPT);
    // Язык ответа — самой последней строкой: блок продуктов написан по-русски и
    // не должен встать за ней (модель берёт язык последних строк как образец).
    const lastLine = system.trim().split('\n').pop();
    expect(lastLine).toBe(LANGUAGE_REPLY_LINE.ru.trim());
  });

  // Правка ждёт исхода до PRODUCT_TOOL_WAIT_MS (2.5 мин) внутри вызова
  // инструмента. Прежние 90 с убивали бы CLI посреди ожидания: правка уже
  // поставлена и идёт, а Маша отвечает «временные проблемы со связью».
  it('таймаут хода вмещает ожидание правки инструментом', async () => {
    const { opts } = await runMasha();
    expect(opts.timeoutMs).toBeGreaterThan(PRODUCT_TOOL_WAIT_MS);
  });

  it('ответ Маши доходит до клиента как обычно', async () => {
    const { writes } = await runMasha();
    const events = writes.map((w) => JSON.parse(w));
    expect(events[0].type).toBe('begin');
    expect(events.find((e) => e.type === 'item')?.content).toContain('Цветы');
    expect(events[events.length - 1].type).toBe('end');
  });
});
