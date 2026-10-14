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

  it('наша команда с аргументами — обращение (контроль)', () => {
    const strict = cfg({ addressing_mode: 'strict', last_reply_at: null });
    expect(router.isExplicitlyAddressed(strict, ctx('/balance@LinkeonAgentBot сейчас'))).toBe(true);
    expect(router.isExplicitlyAddressed(strict, ctx('/help что умеешь'))).toBe(true);
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

  it('с аргументами: наша — наша, чужая — чужая (контроль)', async () => {
    const a = makeCommands();
    expect(await a.svc.tryHandle(CFG, groupMsg('/help@LinkeonAgentBot что умеешь'))).toBe(true);
    const b = makeCommands();
    expect(await b.svc.tryHandle(CFG, groupMsg('/help@OtherBot что умеешь'))).toBe(false);
  });
});

// ─── 5. Владелец узнаёт о нуле ────────────────────────────────────────────────

describe('нулевой баланс: владельцу — одно сообщение в личку', () => {
  function makeBilling(o: { balance: number; firstToday?: boolean; sendFails?: boolean | 'blocked' | 'timeout' | 'flood'; redisDown?: boolean }) {
    const pg = { query: jest.fn(async (sql: string) => (/SELECT tokens/i.test(sql) ? { rows: [{ tokens: o.balance }] } : { rows: [] })) };
    const grammy = {
      sendMessage: jest.fn(async () => {
        if (o.sendFails === 'blocked' || o.sendFails === true) throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 });
        if (o.sendFails === 'timeout') throw new Error('ETIMEDOUT');
        if (o.sendFails === 'flood') throw Object.assign(new Error('Too Many Requests: retry after 5'), { error_code: 429 });
        return {};
      }),
    };
    const redis = {
      setNx: jest.fn(async () => { if (o.redisDown) throw new Error('Connection is closed'); return o.firstToday ?? true; }),
      del: jest.fn(async () => { if (o.redisDown) throw new Error('Connection is closed'); }),
    };
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

  it('временный сбой отправки — ключ снимаем, чтобы повторить в следующий раз', async () => {
    const { svc, redis } = makeBilling({ balance: 0, sendFails: 'timeout' });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(redis.del).toHaveBeenCalledWith('tg:zero-balance-dm:u-owner');
  });

  it('владелец заблокировал бота (403) — отметку держим: иначе попытка на каждое сообщение группы', async () => {
    const { svc, redis } = makeBilling({ balance: 0, sendFails: 'blocked' });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('Telegram просит подождать (429) — это временно: отметку снимаем', async () => {
    const { svc, redis } = makeBilling({ balance: 0, sendFails: 'flood' });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(redis.del).toHaveBeenCalledWith('tg:zero-balance-dm:u-owner');
  });

  it('Redis лёг — ни отметка, ни снятие не роняют ход; без отметки не пишем (иначе — на каждую реплику группы)', async () => {
    const { svc, grammy } = makeBilling({ balance: 0, redisDown: true });
    await expect(svc.notifyOwnerZeroBalance('u-owner', 111)).resolves.toBeUndefined();
    expect(grammy.sendMessage).not.toHaveBeenCalled();
    await expect(svc.clearOwnerZeroBalanceDm('u-owner')).resolves.toBeUndefined();
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

// ─── Ревью хвостов: чужие /start и команды, лички, имя, HTML ───────────────

describe('группа: команда другому боту — не наша', () => {
  function makeBot() {
    const svc = new TgBotService(
      {} as any, {} as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any, { sendMessage: jest.fn() } as any,
      null as any, null as any, { handleReplyEdit: jest.fn(async () => false), handleCaseCommand: jest.fn(async () => false) } as any,
    );
    (svc as any).logger = quiet;
    const claim = jest.spyOn(svc as any, 'handleGroupClaim').mockResolvedValue(undefined);
    const chat = jest.spyOn(svc as any, 'handleChatMessage').mockResolvedValue(undefined);
    return { svc, claim, chat };
  }
  const group = (text: string) => ({ chat: { id: -100123, type: 'supergroup' }, from: { id: 222 }, message_id: 5, text });
  const photo = (caption: string) => ({ chat: { id: -100123, type: 'supergroup' }, from: { id: 222 }, message_id: 6, photo: [{ file_id: 'P' }], caption });

  it('«/start@ДругойБот <код>» (так добавляют чужого бота) — не наша привязка: бот не уходит из группы', async () => {
    const { svc, claim, chat } = makeBot();
    await (svc as any).handleMessage(group('/start@OtherBot abc123'));
    expect(claim).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('«/help@ДругойБот» — ни нашей справки, ни платного хода модели', async () => {
    const { svc, chat } = makeBot();
    await (svc as any).handleMessage(group('/help@OtherBot'));
    expect(chat).not.toHaveBeenCalled();
  });

  it('подпись к фото «/help@ДругойБот» — тоже не наша', async () => {
    const { svc, chat } = makeBot();
    await (svc as any).handleMessage(photo('/help@OtherBot'));
    expect(chat).not.toHaveBeenCalled();
  });

  // Альбом — несколько сообщений, подпись только у одного: выбросить её одну
  // значило бы отдать модели альбом без одной фотографии. Альбом целиком —
  // обычным путём.
  it('альбом с подписью «/help@ДругойБот» не режется: часть с подписью идёт вместе с остальными', async () => {
    const { svc, chat } = makeBot();
    await (svc as any).handleMessage({ ...photo('/help@OtherBot'), media_group_id: 'album-1' });
    expect(chat).toHaveBeenCalled();
  });

  it('наш «/start@LinkeonAgentBot <код>» — привязка, как раньше (контроль)', async () => {
    const { svc, claim } = makeBot();
    await (svc as any).handleMessage(group('/start@LinkeonAgentBot abc123'));
    expect(claim).toHaveBeenCalledWith(expect.anything(), 'abc123');
  });

  it('обычная реплика группы идёт в ход (контроль)', async () => {
    const { svc, chat } = makeBot();
    await (svc as any).handleMessage(group('встречаемся в восемь'));
    expect(chat).toHaveBeenCalled();
  });
});

describe('имя бота в тексте — с начала слова', () => {
  const router = new TgRouterService({} as any, null as any, null as any, null as any, null as any);
  (router as any).logger = quiet;
  const strict = (name: string) => ({ display_name: name, addressing_mode: 'strict', status: 'active', tg_chat_id: '-1' }) as any;
  const said = (text: string) => ({ text, replyToFromBot: false });

  it('склонение имени — обращение: «спроси Финансиста»', () => {
    expect(router.isExplicitlyAddressed(strict('Финансист'), said('спроси Финансиста, сколько'))).toBe(true);
  });

  it('имя внутри другого слова — не обращение: «Рома» в «аромат», «Ли» в «или»', () => {
    expect(router.isExplicitlyAddressed(strict('Рома'), said('какой аромат'))).toBe(false);
    expect(router.isExplicitlyAddressed(strict('Ли'), said('да или нет'))).toBe(false);
  });

  it('китайский пишется без пробелов — там имя ищется где угодно, как раньше', () => {
    expect(router.isExplicitlyAddressed(strict('小助手'), said('请小助手帮忙'))).toBe(true);
    expect(router.isExplicitlyAddressed(strict('Linkeon'), said('请Linkeon帮忙'))).toBe(true);
  });

  it('первое вхождение внутри слова, второе — с начала: «какой аромат, Рома?» — обращение', () => {
    expect(router.isExplicitlyAddressed(strict('Рома'), said('какой аромат, Рома?'))).toBe(true);
  });

  it('огласовки и надстрочные знаки — часть слова: «राम» в «विराम» — не обращение', () => {
    expect(router.isExplicitlyAddressed(strict('राम'), said('थोड़ा विराम लो'))).toBe(false);
    expect(router.isExplicitlyAddressed(strict('राम'), said('राम, नमस्ते'))).toBe(true);
  });

  // У многих эмодзи в конце вариационный селектор U+FE0F — это «знак» (\p{M}),
  // но буквы перед именем он не делает: смотрим на основу, на само «❤».
  it('имя сразу после эмодзи — обращение: «❤️Рома», «⚠️Финансист»', () => {
    const heart = String.fromCodePoint(0x2764, 0xfe0f);
    const warn = String.fromCodePoint(0x26a0, 0xfe0f);
    expect(router.isExplicitlyAddressed(strict('Рома'), said(`${heart}Рома, привет`))).toBe(true);
    expect(router.isExplicitlyAddressed(strict('Финансист'), said(`${warn}Финансист, глянь счёт`))).toBe(true);
  });

  it('японская черта долготы «ー» — тоже письмо без пробелов', () => {
    expect(router.isExplicitlyAddressed(strict('Linkeon'), said('ラーメンーLinkeon'))).toBe(true);
  });

  it('имя из одних пробелов не срабатывает, имя с пробелами по краям — срабатывает', () => {
    expect(router.isExplicitlyAddressed(strict('   '), said('привет  всем'))).toBe(false);
    expect(router.isExplicitlyAddressed(strict(' Рома '), said('Рома, привет'))).toBe(true);
  });

  it('имя с начала строки и после знаков — обращение', () => {
    expect(router.isExplicitlyAddressed(strict('Рома'), said('Рома, привет'))).toBe(true);
    expect(router.isExplicitlyAddressed(strict('Рома'), said('ну, «Рома», скажи'))).toBe(true);
  });
});

describe('имена от людей — в HTML, а не в Markdown', () => {
  it('список /resume: группа «Team_A [x] <y>» не ломает сообщение', async () => {
    const pg = { query: jest.fn(async () => ({ rowCount: 1, rows: [{ id: 'g', display_name: 'Fin_Bot', tg_chat_title: 'Team_A [x] <y>', tg_chat_id: '-100' }] })) };
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const svc = new TgBotService(
      pg as any, { getLinkeonIdByTgUserId: jest.fn(async () => 'u-1') } as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any, grammy as any, null as any, null as any,
      { handleCaseCommand: jest.fn(async () => false) } as any,
    );
    (svc as any).logger = quiet;
    await (svc as any).handleDmCommand({ chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/resume' });
    const [, text, opts] = grammy.sendMessage.mock.calls[0] as any[];
    expect(opts).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
    expect(text).toContain('<b>Fin_Bot</b>');
    expect(text).toContain('Team_A [x] &lt;y&gt;');
  });

  it('/help в группе: имя бота «Fin_Bot» экранировано, HTML', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const svc = new TgCommandsService(null as any, grammy as any, {} as any, { getIdentityByLinkeonId: jest.fn(async () => null) } as any, {} as any, {} as any);
    await svc.tryHandle({ id: 'c1', display_name: 'Fin_<Bot>', addressing_mode: 'strict', owner_user_id: 'u' } as any, { chat: { id: -1 }, from: { id: 2 }, message_id: 3, text: '/help' });
    const [, text, opts] = grammy.sendMessage.mock.calls[0] as any[];
    expect(opts).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
    expect(text).toContain('<b>Fin_&lt;Bot&gt;</b>');
  });
});

describe('имена ассистентов и языков — тоже в HTML', () => {
  function makeCmds(over: { agents?: any[]; preferred?: string } = {}) {
    const grammy = { sendMessage: jest.fn(async () => ({})), answerCallbackQuery: jest.fn(async () => ({})) };
    const pg = { query: jest.fn(async () => ({ rows: over.preferred ? [{ preferred_agent: over.preferred }] : [] })) };
    const agents = { getAgents: jest.fn(async () => over.agents ?? []), changeAgent: jest.fn(async () => {}) };
    const configs = { getActiveByTgChatId: jest.fn(async () => null) };
    const svc = new TgCommandsService(pg as any, grammy as any, {} as any, {} as any, agents as any, configs as any);
    const last = () => grammy.sendMessage.mock.calls[0] as any[];
    return { svc, last };
  }

  it('«Теперь отвечает» — имя ассистента экранировано', async () => {
    const { svc, last } = makeCmds({ agents: [{ name: 'Fin_<A>' }] });
    await svc.handleAgentCallback({ id: 'cb', data: 'agent:Fin_<A>', message: { chat: { id: 42 } }, from: { id: 42 } }, 'u-1');
    expect(last()[1]).toContain('<b>Fin_&lt;A&gt;</b>');
    expect(last()[2]).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
  });

  it('/assistants — текущий ассистент экранирован', async () => {
    const { svc, last } = makeCmds({ preferred: 'Fin_<A>' });
    await svc.handleAssistants({ chat: { id: 42 } }, 'u-1');
    expect(last()[1]).toContain('<b>Fin_&lt;A&gt;</b>');
    expect(last()[2]).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
  });

  it('выбор языка — подпись в HTML', async () => {
    const { svc, last } = makeCmds();
    await svc.handleLanguageCallback({ id: 'cb', data: 'lang:fr', message: { chat: { id: 42 } } }, 'u-1');
    expect(last()[1]).toContain('<b>Français</b>');
    expect(last()[2]).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
  });

  it('/start в личке: имя текущего ассистента — в HTML', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [{ preferred_agent: 'Fin_<A>' }] })) };
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const svc = new TgBotService(
      pg as any, { getLinkeonIdByTgUserId: jest.fn(async () => 'u-1') } as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any, grammy as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    await (svc as any).handleMessage({ chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/start' });
    const [, text, opts] = grammy.sendMessage.mock.calls[0] as any[];
    expect(opts).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
    expect(text).toContain('<b>Fin_&lt;A&gt;</b>');
  });
});

describe('личка: /start с чужим @именем — не код привязки', () => {
  it('«/start@ДругойБот abc» в личке не уходит в привязку по коду', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const svc = new TgBotService(
      {} as any, { getLinkeonIdByTgUserId: jest.fn(async () => null) } as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any, grammy as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    const dmStart = jest.spyOn(svc as any, 'handleDmStart').mockResolvedValue(undefined);
    await (svc as any).handleMessage({ chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/start@OtherBot abc123' });
    expect(dmStart).not.toHaveBeenCalled();
  });
});

describe('привязка в группе не удалась — бот не бросает работающий чат', () => {
  function makeBot(live: any) {
    const grammy = { sendMessage: jest.fn(async () => ({})), leaveChat: jest.fn(async () => true) };
    const claim = { claim: jest.fn(async () => { throw new Error('invalid or expired claim token'); }) };
    const configs = { getActiveByTgChatId: jest.fn(async () => live) };
    const svc = new TgBotService(
      {} as any, {} as any, claim as any, configs as any, null as any,
      null as any, null as any, null as any, null as any, grammy as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    return { svc, grammy };
  }
  const stale = { chat: { id: -100123, type: 'supergroup', title: 'Семья' }, from: { id: 222 }, message_id: 5, text: '/start@LinkeonAgentBot stale' };

  it('в группе уже работает бот — старая ссылка его не выгоняет: пишем в личку и остаёмся', async () => {
    const { svc, grammy } = makeBot({ id: 'cfg-live' });
    await (svc as any).handleMessage(stale);
    expect(grammy.leaveChat).not.toHaveBeenCalled();
    expect(grammy.sendMessage).toHaveBeenCalledWith(222, expect.stringContaining('Не получилось привязать'));
  });

  it('не смогли проверить, есть ли в группе рабочий бот, — остаёмся: выход архивировал бы его', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})), leaveChat: jest.fn(async () => true) };
    const claim = { claim: jest.fn(async () => { throw new Error('invalid or expired claim token'); }) };
    const configs = { getActiveByTgChatId: jest.fn(async () => { throw new Error('Connection terminated'); }) };
    const svc = new TgBotService(
      {} as any, {} as any, claim as any, configs as any, null as any,
      null as any, null as any, null as any, null as any, grammy as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    await (svc as any).handleMessage(stale);
    expect(grammy.leaveChat).not.toHaveBeenCalled();
  });

  it('рабочего бота в группе нет — уходим, как раньше (контроль)', async () => {
    const { svc, grammy } = makeBot(null);
    await (svc as any).handleMessage(stale);
    expect(grammy.leaveChat).toHaveBeenCalledWith(-100123);
  });
});

describe('приглашение на встречу: имя ассистента — экранировано', () => {
  it('«R&D» не ломает HTML-сообщение', async () => {
    const { TgMeetingService } = require('./tg-meeting.service');
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const pg = { query: jest.fn(async () => ({ rows: [{ id: 7, name: 'R&D' }] })) };
    const svc = new TgMeetingService(pg as any, grammy as any, {} as any, {} as any, {} as any, {} as any);
    jest.spyOn(svc as any, 'lookup').mockResolvedValue({ title: 'Планёрка' });
    expect(await svc.tryHandleLink(-100123, 'созвон https://zoom.us/j/123456789', 'u-1')).toBe(true);
    const [, text, opts] = grammy.sendMessage.mock.calls[0] as any[];
    expect(opts).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
    expect(text).toContain('R&amp;D подключится к встрече.');
  });
});

describe('баланс меньше порога: предупреждение владельцу — раз в сутки и без двойников', () => {
  // Проверка идёт в фоне, уже после замка чата: два хода подряд прочли бы пустую
  // отметку оба. Поэтому слот на сутки занимаем одним UPDATE до отправки.
  function makeLow(o: { slotFree?: boolean; sendFails?: 'blocked' | 'timeout' } = {}) {
    const sql: string[] = [];
    const pg = {
      query: jest.fn(async (q: string) => {
        sql.push(q);
        return /RETURNING/i.test(q) ? { rows: o.slotFree === false ? [] : [{ id: 'c1' }] } : { rows: [] };
      }),
    };
    const grammy = {
      sendMessage: jest.fn(async () => {
        if (o.sendFails === 'blocked') throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 });
        if (o.sendFails === 'timeout') throw new Error('ETIMEDOUT');
        return {};
      }),
    };
    const svc = new TgBillingService(pg as any, grammy as any, undefined);
    (svc as any).logger = quiet;
    jest.spyOn(svc, 'getBalance').mockResolvedValue(500);
    return { svc, pg, grammy, sql };
  }
  const released = (sql: string[]) => sql.some((q) => /SET last_low_balance_dm_at = NULL/.test(q));

  it('слот берётся одним UPDATE до отправки — и сообщение уходит', async () => {
    const { svc, pg, grammy, sql } = makeLow();
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(grammy.sendMessage).toHaveBeenCalledTimes(1);
    const claim = sql.find((q) => /RETURNING/i.test(q)) ?? '';
    expect(claim).toMatch(/SET last_low_balance_dm_at = now\(\)/);
    expect(claim).toMatch(/interval '24 hours'/);
    expect(pg.query.mock.invocationCallOrder[0]).toBeLessThan(grammy.sendMessage.mock.invocationCallOrder[0]);
  });

  it('слот уже занят (сегодня писали или пишет соседний ход) — молчим', async () => {
    const { svc, grammy } = makeLow({ slotFree: false });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('временный сбой отправки — слот возвращаем, чтобы повторить', async () => {
    const { svc, sql } = makeLow({ sendFails: 'timeout' });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(released(sql)).toBe(true);
  });

  it('владелец заблокировал бота (403) — слот держим до завтра (контроль)', async () => {
    const { svc, sql } = makeLow({ sendFails: 'blocked' });
    await svc.checkBalanceAlerts('c1', 'u-owner', 111);
    expect(released(sql)).toBe(false);
  });
});
