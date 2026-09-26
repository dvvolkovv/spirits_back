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

// ─── ход Маши в полёте: пинги и учёт живых ходов ────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Прокрутить микрозадачи и настоящие setImmediate, пока условие не станет true. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('условие так и не выполнилось');
}

/**
 * Ход Маши с инструментом идёт минутами: правка ждёт исхода до 2.5 мин внутри
 * вызова инструмента. Раньше между `begin` и ответом не уходило ничего —
 * Flutter-клиент (Dio receiveTimeout 60 с) рвал такой ход ошибкой. И ход не
 * считался живым: deploy.sh ждёт /chat/active-streams только по пути релея, и
 * рестарт посреди хода Маши убивал ответ, а правка продукта тихо доезжала.
 */
describe('Маша: ход в полёте', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_DS = process.env.DEEPSEEK_API_KEY;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-product-tool';
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD_SECRET;
    if (OLD_DS === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = OLD_DS;
  });
  afterEach(() => jest.useRealTimers());

  function slowMasha() {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const cli = deferred<{ text: string; costUsd: number }>();
    const { svc, claudeCli } = makeService();
    claudeCli.textWithCost.mockImplementation(() => cli.promise);
    const { res, writes } = makeRes();
    const run = svc.streamChat(USER, 'Поправь заголовок на сайте', '3', `${USER}_3`, 'Имя: Дмитрий', res);
    const events = () => writes.map((w) => JSON.parse(w));
    return { svc, claudeCli, res, writes, run, cli, events };
  }

  it('пока CLI думает, клиенту раз в ~20 с уходит ping — той же формы, что у релея', async () => {
    const { claudeCli, run, cli, events } = slowMasha();
    await until(() => claudeCli.textWithCost.mock.calls.length === 1);

    jest.advanceTimersByTime(41_000);
    const pings = events().filter((e) => e.type === 'ping');
    expect(pings).toHaveLength(2);
    // Ровно {"type":"ping"}: без content/text/delta веб и Flutter его пропускают.
    expect(pings[0]).toEqual({ type: 'ping' });

    cli.resolve({ text: 'Готово.', costUsd: 0.01 });
    await run;
    // После ответа пингов больше нет, и порядок событий цел.
    jest.advanceTimersByTime(60_000);
    expect(events().map((e) => e.type)).toEqual(['begin', 'ping', 'ping', 'item', 'end']);
  });

  it('ход считается живым, пока идёт, и перестаёт — когда ответ ушёл', async () => {
    const { svc, claudeCli, run, cli } = slowMasha();
    await until(() => claudeCli.textWithCost.mock.calls.length === 1);
    expect(svc.getActiveStreamCount()).toBe(1);
    expect(svc.getActiveTurn(USER, '3').active).toBe(true);

    cli.resolve({ text: 'Готово.', costUsd: 0.01 });
    await run;
    expect(svc.getActiveStreamCount()).toBe(0);
    expect(svc.getActiveTurn(USER, '3').active).toBe(false);
  });

  it('CLI упал — счётчики сняты, клиент получил ответ-заглушку', async () => {
    const { svc, claudeCli, run, cli, events } = slowMasha();
    await until(() => claudeCli.textWithCost.mock.calls.length === 1);
    cli.reject(new Error('claude CLI exited with code 1: boom'));
    await run;
    expect(svc.getActiveStreamCount()).toBe(0);
    expect(svc.getActiveTurn(USER, '3').active).toBe(false);
    expect(events().map((e) => e.type)).toEqual(['begin', 'item', 'end']);
  });

  it('CLI упёрся в таймаут — счётчики сняты', async () => {
    const { svc, claudeCli, run, cli } = slowMasha();
    await until(() => claudeCli.textWithCost.mock.calls.length === 1);
    cli.reject(new Error('claude CLI timeout after 600000ms'));
    await run;
    expect(svc.getActiveStreamCount()).toBe(0);
    expect(svc.getActiveTurn(USER, '3').active).toBe(false);
  });

  it('упала сама отправка ответа — счётчики всё равно сняты, пинги остановлены', async () => {
    const { svc, claudeCli, res, run, cli, writes } = slowMasha();
    await until(() => claudeCli.textWithCost.mock.calls.length === 1);
    res.write.mockImplementation((s: string) => {
      if (s.includes('"type":"item"')) throw new Error('socket closed');
      writes.push(s);
      return true;
    });
    cli.resolve({ text: 'Готово.', costUsd: 0.01 });
    await expect(run).rejects.toThrow('socket closed');
    expect(svc.getActiveStreamCount()).toBe(0);
    expect(svc.getActiveTurn(USER, '3').active).toBe(false);
    const before = writes.length;
    jest.advanceTimersByTime(60_000);
    expect(writes.length).toBe(before);
  });
});

// ─── метафорическая карта и ход с продуктом ─────────────────────────────────

/**
 * Карта подмешивается по регулярке (`/карт/i` в ответе), а в разговоре о
 * сайте «картинку», «карточку товара», «карту сайта» говорят постоянно —
 * к отчёту о правке прилетала бы случайная метафорическая карта (и ещё
 * менялся бы game_sessions). Ход, где звали инструмент продуктов, карту не
 * получает; обычная просьба о карте работает как раньше.
 */
describe('Маша: метафорическая карта не цепляется к ходу с продуктом', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_DS = process.env.DEEPSEEK_API_KEY;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-product-tool';
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD_SECRET;
    if (OLD_DS === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = OLD_DS;
  });

  const CARD_URL = 'https://images.linkeon.io/cards/card-7.jpg';

  async function runWith(impl: (prompt: string, opts: any) => Promise<{ text: string; costUsd: number }>) {
    const { svc, claudeCli } = makeService();
    claudeCli.textWithCost.mockImplementation(impl);
    const cardSpy = jest.spyOn(svc as any, 'getRandomMetaphorCard').mockResolvedValue(CARD_URL);
    const { res, writes } = makeRes();
    await svc.streamChat(USER, 'сообщение', '3', `${USER}_3`, 'Имя: Дмитрий', res);
    await new Promise((r) => setImmediate(r));
    const item = writes.map((w) => JSON.parse(w)).find((e) => e.type === 'item');
    return { claudeCli, cardSpy, item };
  }

  it('CLI Маши зовётся с onProgress — иначе вызов инструмента не увидеть', async () => {
    const { claudeCli } = await runWith(async () => ({ text: 'Привет.', costUsd: 0.01 }));
    expect(typeof claudeCli.textWithCost.mock.calls[0][1].onProgress).toBe('function');
  });

  it('звали инструмент продуктов, в ответе «картинку» — карты нет, game_sessions не трогаем', async () => {
    const { cardSpy, item } = await runWith(async (_p, opts) => {
      opts.onProgress?.({ kind: 'tool_use', name: 'mcp__products__manage_product' });
      return { text: 'Готово: поменяла картинку и карточку товара на главной вашего сайта.', costUsd: 0.01 };
    });
    expect(cardSpy).not.toHaveBeenCalled();
    expect(item.content).not.toContain('Метафорическая карта');
  });

  it('без инструмента просьба о карте работает как раньше', async () => {
    const { cardSpy, item } = await runWith(async () => ({ text: 'Вот карта для тебя. Что ты видишь?', costUsd: 0.01 }));
    expect(cardSpy).toHaveBeenCalled();
    expect(item.content).toContain(`![Метафорическая карта](${CARD_URL})`);
  });
});
