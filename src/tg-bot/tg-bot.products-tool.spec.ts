import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TgRouterService } from './tg-router.service';
import { TgBotService } from './tg-bot.service';
import { verifyProductToolToken } from '../products/product-tool.token';
import { PRODUCTS_CLI_PROMPT } from '../products/products-cli-tool';

/**
 * ИНСТРУМЕНТ ПРОДУКТОВ В TELEGRAM-БОТЕ.
 *
 * Решение владельца (26.09.2026): инструмент есть в ходе ТОЛЬКО если
 *   1) текущее сообщение написал сам владелец бота — его Telegram привязан к
 *      тому же аккаунту Linkeon, что владеет конфигом, И
 *   2) в этом чате за всю историю не писал никто, кроме него.
 * Личка проходит сама собой. Кто-то другой хоть раз написал — в этом чате
 * инструмента нет навсегда: чужая реплика в истории могла бы править продукты
 * владельца его же руками. Без инструмента ход — ровно прежний.
 * Правки из Telegram ложатся в product_turns с channel='telegram'.
 */

const TOOL = 'mcp__products__manage_product';
const WEB = ['WebSearch', 'WebFetch'];

const OLD_SECRET = process.env.JWT_SECRET;
beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-product-tool'; });
afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });

// ─── generateReply: что уходит в CLI ─────────────────────────────────────────

function makeRouter(pg: any = {}) {
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'ответ', costUsd: 0.01 })),
  };
  const svc = new TgRouterService(pg, null as any, null as any, null as any, claudeCli as any);
  jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ systemPrompt: 'системный промпт' });
  jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'поправь сайт' }]);
  jest.spyOn(svc as any, 'listWorkspace').mockReturnValue([]);
  return { svc, claudeCli };
}

const GROUP_CFG: any = { id: 'cfg-g', owner_user_id: 'u-owner', tg_chat_id: '-100123' };
const optsOf = (c: any) => c.textWithCost.mock.calls[0][1];

describe('TgRouterService.generateReply: инструмент продуктов', () => {
  it('с productsOwnerId: MCP-сервер, токен владельца с каналом telegram', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(GROUP_CFG, 'Дмитрий', undefined, undefined, undefined, { productsOwnerId: 'u-owner' });

    const opts = optsOf(claudeCli);
    expect(opts.mcpServers?.products?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhook\/mcp\/products$/);
    const bearer = String(opts.mcpServers.products.headers?.Authorization ?? '');
    expect(verifyProductToolToken(bearer.replace(/^Bearer /, ''))).toEqual({ userId: 'u-owner', channel: 'telegram' });
  });

  it('с productsOwnerId: инструмент добавлен в allowedTools, веб сохранён, встроенный набор прежний', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(GROUP_CFG, 'Дмитрий', undefined, undefined, '/tmp/sandbox-x', { productsOwnerId: 'u-owner' });

    const opts = optsOf(claudeCli);
    expect(String(opts.allowedTools).split(',').sort()).toEqual([...WEB, TOOL].sort());
    // --tools — только встроенные: MCP-инструмент доступен и без него (проба CLI 2.1.280).
    expect(opts.tools).toBe('Read,WebSearch,WebFetch');
  });

  it('с productsOwnerId: блок про продукты — в системном промпте', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(GROUP_CFG, 'Дмитрий', undefined, undefined, undefined, { productsOwnerId: 'u-owner' });
    expect(String(optsOf(claudeCli).system)).toContain(PRODUCTS_CLI_PROMPT);
  });

  it('без productsOwnerId: ход ровно прежний — ни сервера, ни инструмента, ни блока', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(GROUP_CFG, 'Дмитрий');

    const opts = optsOf(claudeCli);
    expect(opts.mcpServers).toBeUndefined();
    expect(String(opts.allowedTools).split(',').sort()).toEqual([...WEB].sort());
    expect(opts.tools).toBe('WebSearch,WebFetch');
    expect(String(opts.system)).not.toContain('mcp__products__');
  });

  it('пустой productsOwnerId — как без него', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(GROUP_CFG, 'Дмитрий', undefined, undefined, undefined, { productsOwnerId: undefined });
    expect(optsOf(claudeCli).mcpServers).toBeUndefined();
    expect(String(optsOf(claudeCli).allowedTools)).not.toContain(TOOL);
  });
});

// ─── кто писал в чате ────────────────────────────────────────────────────────

describe('TgRouterService.onlySpeakerIs: в чате писал только этот человек', () => {
  const routerWith = (row: any) => {
    const pg = { query: jest.fn(async (_sql: string, _p?: any[]) => ({ rows: [row] })) };
    return { svc: new TgRouterService(pg as any, null as any, null as any, null as any, null as any), pg };
  };

  it('только его сообщения — да', async () => {
    const { svc } = routerWith({ others: '0', mine: '3' });
    await expect(svc.onlySpeakerIs(GROUP_CFG, 111)).resolves.toBe(true);
  });

  it('есть чужое сообщение хоть одно — нет', async () => {
    const { svc } = routerWith({ others: '1', mine: '5' });
    await expect(svc.onlySpeakerIs(GROUP_CFG, 111)).resolves.toBe(false);
  });

  it('его сообщений нет вовсе (текущее не сохранилось) — нет', async () => {
    const { svc } = routerWith({ others: '0', mine: '0' });
    await expect(svc.onlySpeakerIs(GROUP_CFG, 111)).resolves.toBe(false);
  });

  it('считает по всему чату (tg_chat_id), только реплики людей, с этим отправителем', async () => {
    const { svc, pg } = routerWith({ others: '0', mine: '1' });
    await svc.onlySpeakerIs(GROUP_CFG, 111);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toMatch(/FROM tg_bot_messages/);
    expect(sql).toMatch(/tg_chat_id = \$1/);
    expect(sql).toMatch(/role = 'user'/);
    expect(params).toEqual(['-100123', 111]);
  });

  it('у конфига нет чата — нет, и в базу не ходим', async () => {
    const { svc, pg } = routerWith({ others: '0', mine: '1' });
    await expect(svc.onlySpeakerIs({ ...GROUP_CFG, tg_chat_id: null }, 111)).resolves.toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
  });
});

// ─── гейт: кому дать инструмент ──────────────────────────────────────────────

function makeGateBot(o: { linkeonId?: string | null; solo?: boolean; identityThrows?: boolean } = {}) {
  const identity = {
    getLinkeonIdByTgUserId: jest.fn(async (_tg: number) => {
      if (o.identityThrows) throw new Error('pg down');
      return o.linkeonId === undefined ? 'u-owner' : o.linkeonId;
    }),
  };
  const router = { onlySpeakerIs: jest.fn(async (_cfg: any, _tg: number) => o.solo ?? true) };
  const svc = new TgBotService(
    null as any, identity as any, null as any, null as any, router as any,
    null as any, null as any, null as any, null as any, null as any, null as any, null as any,
  );
  (svc as any).logger = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };
  return { svc, identity, router };
}

const groupMsg = (fromId: number) => ({ chat: { id: -100123, type: 'supergroup' }, from: { id: fromId }, message_id: 7, text: 'поправь сайт' });

describe('TgBotService: кому в этом ходе дать инструмент продуктов', () => {
  it('пишет владелец, и в чате никто другой не писал — инструмент его', async () => {
    const { svc, router } = makeGateBot({ linkeonId: 'u-owner', solo: true });
    await expect((svc as any).productsOwnerForTurn(GROUP_CFG, groupMsg(111))).resolves.toBe('u-owner');
    expect(router.onlySpeakerIs).toHaveBeenCalledWith(GROUP_CFG, 111);
  });

  it('пишет не владелец — инструмента нет', async () => {
    const { svc } = makeGateBot({ linkeonId: 'u-someone-else', solo: true });
    await expect((svc as any).productsOwnerForTurn(GROUP_CFG, groupMsg(222))).resolves.toBeUndefined();
  });

  it('пишет владелец, но раньше в чате писал кто-то ещё — инструмента нет', async () => {
    const { svc } = makeGateBot({ linkeonId: 'u-owner', solo: false });
    await expect((svc as any).productsOwnerForTurn(GROUP_CFG, groupMsg(111))).resolves.toBeUndefined();
  });

  it('Telegram отправителя не привязан к Linkeon — инструмента нет', async () => {
    const { svc } = makeGateBot({ linkeonId: null, solo: true });
    await expect((svc as any).productsOwnerForTurn(GROUP_CFG, groupMsg(333))).resolves.toBeUndefined();
  });

  it('личка владельца — инструмент есть', async () => {
    const privateCfg: any = { id: 'cfg-p', owner_user_id: 'u-owner', tg_chat_id: '111' };
    const { svc } = makeGateBot({ linkeonId: 'u-owner', solo: true });
    const msg = { chat: { id: 111, type: 'private' }, from: { id: 111 }, message_id: 8, text: 'покажи мои сайты' };
    await expect((svc as any).productsOwnerForTurn(privateCfg, msg)).resolves.toBe('u-owner');
  });

  // Сбой проверки не может выдать инструмент: без него бот работает как раньше.
  it('проверка упала — инструмента нет', async () => {
    const { svc } = makeGateBot({ identityThrows: true });
    await expect((svc as any).productsOwnerForTurn(GROUP_CFG, groupMsg(111))).resolves.toBeUndefined();
  });

  it('у сообщения нет отправителя — инструмента нет', async () => {
    const { svc, identity } = makeGateBot();
    await expect((svc as any).productsOwnerForTurn(GROUP_CFG, { chat: { id: -100123 }, message_id: 9 })).resolves.toBeUndefined();
    expect(identity.getLinkeonIdByTgUserId).not.toHaveBeenCalled();
  });
});

// ─── проводка: гейт доезжает до generateReply ────────────────────────────────

describe('TgBotService.handleChatMessage: решение гейта уходит в generateReply', () => {
  let root: string;
  let prevRoot: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-products-spec-'));
    prevRoot = process.env.TG_WORKSPACE_ROOT;
    process.env.TG_WORKSPACE_ROOT = root;
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.TG_WORKSPACE_ROOT;
    else process.env.TG_WORKSPACE_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeTurnBot(o: { linkeonId: string | null; solo: boolean }) {
    const order: string[] = [];
    const pg = {
      tryAdvisoryLock: jest.fn(async () => ({ release: jest.fn(async () => {}) })),
      query: jest.fn(async () => ({ rows: [{ first_name: 'Дмитрий' }] })),
    };
    const identity = {
      getLinkeonIdByTgUserId: jest.fn(async () => o.linkeonId),
      getIdentityByLinkeonId: jest.fn(async () => null),
    };
    const router = {
      persistUserMessage: jest.fn(async () => { order.push('persist'); }),
      shouldRespond: jest.fn(async () => true),
      markAnswerExpected: jest.fn(async () => {}),
      onlySpeakerIs: jest.fn(async () => { order.push('onlySpeakerIs'); return o.solo; }),
      generateReply: jest.fn(async (..._a: any[]) => { order.push('generateReply'); return { text: 'готово', costUsd: 0.01 }; }),
      persistAssistantReply: jest.fn(async () => {}),
      consolidateAfterReply: jest.fn(async () => {}),
      persistTurnFailure: jest.fn(async () => {}),
    };
    const billing = {
      getBalance: jest.fn(async () => 100000),
      tokensForTurn: jest.fn(() => 36),
      deduct: jest.fn(async () => 99964),
      alertIfExpensiveTurn: jest.fn(async () => {}),
      clearZeroBalanceFlag: jest.fn(async () => {}),
      checkBalanceAlerts: jest.fn(async () => {}),
    };
    const commands = { tryHandle: jest.fn(async () => false) };
    const meetings = { tryHandleLink: jest.fn(async () => false) };
    const grammy = {
      getBotUserId: jest.fn(async () => 999),
      sendChatAction: jest.fn(async () => {}),
      sendMessage: jest.fn(async () => ({ message_id: 55 })),
      editMessageText: jest.fn(async () => {}),
      deleteMessage: jest.fn(async () => {}),
    };
    const svc = new TgBotService(
      pg as any, identity as any, null as any, null as any, router as any,
      null as any, billing as any, commands as any, meetings as any, grammy as any, null as any, null as any,
    );
    (svc as any).logger = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };
    return { svc, router, order };
  }

  const CFG: any = {
    id: 'cfg-wire', owner_user_id: 'u-owner', tg_chat_id: '-100123',
    voice_reply_mode: 'never', addressing_mode: 'always', status: 'active',
  };
  const lastGenerateOpts = (router: any) => {
    const call = router.generateReply.mock.calls[0];
    return call[5];
  };

  it('владелец в сольном чате: generateReply получает productsOwnerId владельца', async () => {
    const { svc, router, order } = makeTurnBot({ linkeonId: 'u-owner', solo: true });
    await (svc as any).handleChatMessage(groupMsg(111), CFG);
    expect(router.generateReply).toHaveBeenCalledTimes(1);
    expect(lastGenerateOpts(router)).toEqual({ productsOwnerId: 'u-owner' });
    // Текущее сообщение уже сохранено к моменту проверки — оно тоже учтено.
    expect(order.indexOf('persist')).toBeLessThan(order.indexOf('onlySpeakerIs'));
    expect(order.indexOf('onlySpeakerIs')).toBeLessThan(order.indexOf('generateReply'));
  });

  it('пишет не владелец: инструмента нет', async () => {
    const { svc, router } = makeTurnBot({ linkeonId: 'u-other', solo: true });
    await (svc as any).handleChatMessage(groupMsg(222), CFG);
    expect(router.generateReply).toHaveBeenCalledTimes(1);
    expect(lastGenerateOpts(router)?.productsOwnerId).toBeUndefined();
  });

  it('владелец, но в чате писали другие: инструмента нет', async () => {
    const { svc, router } = makeTurnBot({ linkeonId: 'u-owner', solo: false });
    await (svc as any).handleChatMessage(groupMsg(111), CFG);
    expect(lastGenerateOpts(router)?.productsOwnerId).toBeUndefined();
  });
});

// ─── статус в чате ───────────────────────────────────────────────────────────

describe('статус-сообщение на время инструмента', () => {
  it('инструмент продуктов — «Работаю с продуктом»', () => {
    expect(TgBotService.toolStatusLabel('mcp__products__manage_product')).toBe('🛠 Работаю с продуктом...');
  });

  it('прежние подписи не сдвинулись', () => {
    expect(TgBotService.toolStatusLabel('WebSearch')).toBe('🌐 Ищу в интернете...');
    expect(TgBotService.toolStatusLabel('Read')).toBe('📄 Читаю файл...');
    expect(TgBotService.toolStatusLabel('mcp__linkeon__generate_video')).toBe('🎬 Запускаю генерацию видео...');
    expect(TgBotService.toolStatusLabel('SomethingElse')).toBe('⚙️ SomethingElse...');
  });
});
