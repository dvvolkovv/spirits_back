import { TgBotService } from './tg-bot.service';
import { TgRouterService } from './tg-router.service';
import { TgCommandsService } from './tg-commands.service';
import { TgBillingService } from './tg-billing.service';

/**
 * Хвосты ревью TG-бота (13–14.10.2026), решение владельца — «сделай»:
 *   1. /silent в личке глушил и саму личку;
 *   2. «умный» режим минуту не слышал прямых обращений, а в личке быстрое
 *      уточнение терялось на 3-секундном лимите;
 *   3. /help@ДругойБот считался командой нашему боту;
 *   5. при нулевом балансе владелец ничего не узнавал (алерт — только при
 *      0 < баланс < порога, а в группах «по обращению» объяснение получает лишь
 *      тот, кто позвал бота).
 * Пункт 4 (эхо голосовых в HTML) — в tg-bot.quiet-unless-answering.spec.ts.
 */

const quiet = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };

const OLD_USERNAME = process.env.TG_BOT_USERNAME;
beforeAll(() => { process.env.TG_BOT_USERNAME = 'LinkeonAgentBot'; });
afterAll(() => {
  if (OLD_USERNAME === undefined) delete process.env.TG_BOT_USERNAME;
  else process.env.TG_BOT_USERNAME = OLD_USERNAME;
});

// ─── 1. /silent и /resume в личке ────────────────────────────────────────────

describe('личка: /silent глушит группы, но не саму личку', () => {
  function makeBot(rows: any[] = [{ id: 'g1', display_name: 'Финансист', tg_chat_title: 'Семья', tg_chat_id: '-100123' }]) {
    const pg = { query: jest.fn(async (_sql: string, _p?: any[]) => ({ rowCount: rows.length, rows })) };
    const identity = { getLinkeonIdByTgUserId: jest.fn(async () => 'u-owner') };
    const grammy = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
    const blog = { handleCaseCommand: jest.fn(async () => false) };
    const svc = new TgBotService(
      pg as any, identity as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any, grammy as any,
      null as any, null as any, blog as any,
    );
    (svc as any).logger = quiet;
    const sql = () => String(pg.query.mock.calls[0][0]);
    const reply = () => String((grammy.sendMessage.mock.calls[0] as any[])[1]);
    return { svc, sql, reply };
  }
  const dm = (text: string) => ({ chat: { id: 42, type: 'private' }, from: { id: 42 }, text });

  it('/silent трогает только группы — личка с ботом не замолкает', async () => {
    const { svc, sql } = makeBot();
    await (svc as any).handleDmCommand(dm('/silent'));
    expect(sql()).toMatch(/tg_chat_id\s*<\s*0/);
  });

  it('/resume будит всё — и личку, заглушённую прежней ошибкой', async () => {
    const { svc, sql } = makeBot();
    await (svc as any).handleDmCommand(dm('/resume'));
    expect(sql()).not.toMatch(/tg_chat_id\s*<\s*0/);
  });

  it('проснувшаяся личка в ответе — «в личке», а не «в «группе»»', async () => {
    const { svc, reply } = makeBot([{ id: 'dm', display_name: 'Linkeon', tg_chat_title: null, tg_chat_id: '42' }]);
    await (svc as any).handleDmCommand(dm('/resume'));
    expect(reply()).toContain('в личке');
    expect(reply()).not.toContain('«группе»');
  });
});

// ─── 2–3. Решения роутера ─────────────────────────────────────────────────────

describe('роутер: прямое обращение не ждёт лимита, чужие команды — не наши', () => {
  const router = new TgRouterService({} as any, null as any, null as any, null as any, null as any);
  (router as any).logger = quiet;
  const justReplied = () => new Date(Date.now() - 1000).toISOString();
  const cfg = (over: any = {}) =>
    ({ id: 'c1', display_name: 'Финансист', addressing_mode: 'smart', status: 'active', tg_chat_id: '-100123', last_reply_at: justReplied(), ...over }) as any;
  const ctx = (text: string, replyToFromBot = false) => ({ text, replyToFromBot }) as any;

  it('«умно»: прямое обращение сразу после ответа — отвечает, а не молчит минуту', async () => {
    expect(await router.shouldRespond(cfg(), ctx('Финансист, а подробнее?'))).toBe(true);
    expect(await router.shouldRespond(cfg(), ctx('ага', true))).toBe(true);
  });

  it('«умно»: сам не вмешивается чаще раза в минуту — и гейт модели при этом не зовётся', async () => {
    const gate = jest.spyOn(TgRouterService.prototype as any, 'smartGate');
    expect(await router.shouldRespond(cfg(), ctx('встречаемся в восемь'))).toBe(false);
    expect(gate).not.toHaveBeenCalled();
    gate.mockRestore();
  });

  it('«на каждое сообщение» в группе: прямое обращение — сразу, обычная реплика — по лимиту', async () => {
    const always = cfg({ addressing_mode: 'always' });
    expect(await router.shouldRespond(always, ctx('Финансист, и ещё'))).toBe(true);
    expect(await router.shouldRespond(always, ctx('просто болтаем'))).toBe(false);
  });

  it('личка: быстрое уточнение сразу после ответа не теряется', async () => {
    const dm = cfg({ addressing_mode: 'always', tg_chat_id: '42' });
    expect(await router.shouldRespond(dm, ctx('а ещё?'))).toBe(true);
  });

  it('команда другому боту — не обращение к нашему', async () => {
    const strict = cfg({ addressing_mode: 'strict', last_reply_at: null });
    expect(router.isExplicitlyAddressed(strict, ctx('/help@OtherBot'))).toBe(false);
    expect(router.isExplicitlyAddressed(strict, ctx('/help@LinkeonAgentBot'))).toBe(true);
    expect(router.isExplicitlyAddressed(strict, ctx('/help@linkeonagentbot'))).toBe(true);
    expect(router.isExplicitlyAddressed(strict, ctx('/help'))).toBe(true);
    expect(await router.shouldRespond(strict, ctx('/balance@OtherBot'))).toBe(false);
  });
});

describe('команды в группе: чужому боту не отвечаем своей справкой', () => {
  function makeCommands() {
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const identity = { getIdentityByLinkeonId: jest.fn(async () => null) };
    const svc = new TgCommandsService(null as any, grammy as any, {} as any, identity as any, {} as any, {} as any);
    return { svc, grammy };
  }
  const CFG: any = { id: 'c1', display_name: 'Финансист', addressing_mode: 'strict', owner_user_id: 'u-owner' };
  const groupMsg = (text: string) => ({ chat: { id: -100123 }, from: { id: 222 }, message_id: 5, text });

  it('/help@OtherBot — не наша команда', async () => {
    const { svc, grammy } = makeCommands();
    expect(await svc.tryHandle(CFG, groupMsg('/help@OtherBot'))).toBe(false);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('/help@LinkeonAgentBot и голый /help — наши (контроль)', async () => {
    const a = makeCommands();
    expect(await a.svc.tryHandle(CFG, groupMsg('/help@LinkeonAgentBot'))).toBe(true);
    const b = makeCommands();
    expect(await b.svc.tryHandle(CFG, groupMsg('/help'))).toBe(true);
  });
});

// ─── 5. Владелец узнаёт о нуле ────────────────────────────────────────────────

describe('нулевой баланс: владельцу — одно сообщение в личку', () => {
  function makeBilling(o: { balance: number; firstToday?: boolean; sendFails?: boolean }) {
    const pg = { query: jest.fn(async (sql: string) => (/SELECT tokens/i.test(sql) ? { rows: [{ tokens: o.balance }] } : { rows: [] })) };
    const grammy = {
      sendMessage: jest.fn(async () => {
        if (o.sendFails) throw new Error('bot was blocked by the user');
        return {};
      }),
    };
    const redis = { setNx: jest.fn(async () => o.firstToday ?? true), del: jest.fn(async () => {}) };
    const svc = new TgBillingService(pg as any, grammy as any, redis as any);
    (svc as any).logger = quiet;
    jest.spyOn(svc, 'getBalance').mockResolvedValue(o.balance);
    return { svc, grammy, redis };
  }

  it('баланс дошёл до нуля — владелец получает сообщение, ключ на сутки', async () => {
    const { svc, grammy, redis } = makeBilling({ balance: 0 });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(grammy.sendMessage).toHaveBeenCalledTimes(1);
    expect((grammy.sendMessage.mock.calls[0] as any[])[0]).toBe(111);
    expect(String((grammy.sendMessage.mock.calls[0] as any[])[1])).toContain('закончились');
    expect(redis.setNx).toHaveBeenCalledWith('tg:zero-balance-dm:u-owner', '1', 24 * 60 * 60 * 1000);
  });

  it('уже сообщали сегодня — не повторяем', async () => {
    const { svc, grammy } = makeBilling({ balance: 0, firstToday: false });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('сообщение не ушло — ключ снимаем, чтобы повторить в следующий раз', async () => {
    const { svc, redis } = makeBilling({ balance: 0, sendFails: true });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(redis.del).toHaveBeenCalledWith('tg:zero-balance-dm:u-owner');
  });

  it('Telegram владельца не привязан — молчим', async () => {
    const { svc, grammy } = makeBilling({ balance: 0 });
    await svc.notifyOwnerZeroBalance('u-owner', null);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('после пополнения отметка снимается — следующий ноль снова сообщит', async () => {
    const { svc, redis } = makeBilling({ balance: 5000 });
    await svc.clearOwnerZeroBalanceDm('u-owner');
    expect(redis.del).toHaveBeenCalledWith('tg:zero-balance-dm:u-owner');
  });
});
