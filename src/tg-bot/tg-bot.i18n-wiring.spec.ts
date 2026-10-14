import { TgBotService } from './tg-bot.service';
import { TgCommandsService } from './tg-commands.service';
import { TgBillingService } from './tg-billing.service';
import { TgMeetingService } from './tg-meeting.service';
import { TgVideoDispatchService } from './tg-video-dispatch.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgConfigService } from './tg-config.service';
import { tgText, formatTgNumber, tgCommandMenus } from './tg-i18n';
import { escapeHtml } from './tg-html';

/**
 * Служебные сообщения бота — на языке человека (14.10.2026, «доделай»):
 * каждый путь, которым бот пишет сам, берёт язык из одного места — языка
 * владельца, а кто ещё не привязан, — языка его клиента Telegram.
 * Плюс два хвоста того же захода: команды меню в группе не уходят в платный
 * ход, а переезд группы в супергруппу не глушит бота.
 */

const quiet = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };
const OLD_USERNAME = process.env.TG_BOT_USERNAME;
beforeAll(() => { process.env.TG_BOT_USERNAME = 'LinkeonAgentBot'; });
afterAll(() => {
  if (OLD_USERNAME === undefined) delete process.env.TG_BOT_USERNAME;
  else process.env.TG_BOT_USERNAME = OLD_USERNAME;
});

/** pg, у которого владелец говорит на lang; прочие запросы — через extra. */
function pgSpeaking(lang: string | null, extra: (sql: string, p?: any[]) => any = () => ({ rows: [] })) {
  return {
    query: jest.fn(async (sql: string, p?: any[]) =>
      /profile_data->>'language'/.test(sql) ? { rows: lang ? [{ language: lang }] : [] } : extra(sql, p)),
    tryAdvisoryLock: jest.fn(async () => ({ release: jest.fn(async () => {}) })),
  };
}

function makeBot(o: { pg?: any; identity?: any; claim?: any; configs?: any; billing?: any; commands?: any } = {}) {
  const grammy = {
    sendMessage: jest.fn(async (..._a: any[]) => ({ message_id: 55 })),
    editMessageText: jest.fn(async () => {}),
    leaveChat: jest.fn(async () => true),
  };
  const blog = { handleCaseCommand: jest.fn(async () => false), handleReplyEdit: jest.fn(async () => false) };
  const svc = new TgBotService(
    (o.pg ?? pgSpeaking(null)) as any, (o.identity ?? { getLinkeonIdByTgUserId: jest.fn(async () => null) }) as any,
    (o.claim ?? null) as any, (o.configs ?? null) as any, null as any, null as any, (o.billing ?? null) as any,
    (o.commands ?? null) as any, null as any, grammy as any, null as any, null as any, blog as any,
  );
  (svc as any).logger = quiet;
  const sent = () => grammy.sendMessage.mock.calls.map((c: any[]) => ({ text: String(c[1]), opts: c[2] ?? {} }));
  return { svc, grammy, sent };
}
const dm = (text: string, from: any = {}) => ({ chat: { id: 42, type: 'private' }, from: { id: 42, ...from }, text });

// ─── Личка ─────────────────────────────────────────────────────────────────────

describe('личка: язык привязанного — из профиля, непривязанного — из клиента Telegram', () => {
  it('непривязанный, Telegram по-французски: /start и кнопка — по-французски', async () => {
    const { svc, sent } = makeBot();
    await (svc as any).handleMessage(dm('/start', { language_code: 'fr' }));
    expect(sent()[0].text).toBe(tgText('fr', 'start_unlinked'));
    expect(sent()[0].opts.reply_markup.inline_keyboard[0][0].text).toBe(tgText('fr', 'open_linkeon'));
  });

  it('клиент на языке, которого у нас нет, — английский', async () => {
    const { svc, sent } = makeBot();
    await (svc as any).handleMessage(dm('/start', { language_code: 'it' }));
    expect(sent()[0].text).toBe(tgText('en', 'start_unlinked'));
  });

  it('привязанный, профиль по-немецки: /help — по-немецки, даже если Telegram по-английски', async () => {
    const { svc, sent } = makeBot({
      pg: pgSpeaking('de'),
      identity: { getLinkeonIdByTgUserId: jest.fn(async () => 'u-1') },
    });
    await (svc as any).handleMessage(dm('/help', { language_code: 'en' }));
    expect(sent()[0].text).toBe(tgText('de', 'dm_help'));
  });

  it('профиль по-испански (Telegram по-немецки): /balance — по-испански и с испанскими разрядами', async () => {
    const { svc, sent } = makeBot({
      pg: pgSpeaking('es'),
      identity: { getLinkeonIdByTgUserId: jest.fn(async () => 'u-1') },
      billing: { getBalance: jest.fn(async () => 12345) },
    });
    await (svc as any).handleMessage(dm('/balance', { language_code: 'de' }));
    expect(sent()[0].text).toBe(tgText('es', 'balance', { balance: formatTgNumber('es', 12345) }));
    expect(sent()[0].opts).toEqual(expect.objectContaining({ parse_mode: 'HTML' }));
  });

  it('/silent: список — на языке владельца', async () => {
    const pg = pgSpeaking('pt', (sql) =>
      /UPDATE tg_bot_configs SET status/.test(sql)
        ? { rowCount: 1, rows: [{ id: 'g', display_name: 'Fin', tg_chat_title: 'Equipa', tg_chat_id: '-100' }] }
        : { rows: [] });
    const { svc, sent } = makeBot({ pg, identity: { getLinkeonIdByTgUserId: jest.fn(async () => 'u-1') } });
    await (svc as any).handleMessage(dm('/silent'));
    expect(sent()[0].text).toBe(`${tgText('pt', 'silenced')}\n${tgText('pt', 'list_group', { name: 'Fin', group: 'Equipa' })}`);
  });

  it('непривязанный: /balance ведёт в Linkeon кнопкой, а не советом «зайдите в кабинет»', async () => {
    const { svc, sent } = makeBot();
    await (svc as any).handleMessage(dm('/balance', { language_code: 'de' }));
    expect(sent()[0].text).toBe(tgText('de', 'unlinked_command'));
    expect(sent()[0].opts.reply_markup.inline_keyboard[0][0].web_app).toBeDefined();
  });

  it('незнакомая команда — на языке клиента', async () => {
    const { svc, sent } = makeBot();
    await (svc as any).handleMessage(dm('/foo', { language_code: 'en' }));
    expect(sent()[0].text).toBe(tgText('en', 'unknown_command'));
  });

  it('привязка по ссылке: «готово» — на языке профиля, если он задан', async () => {
    const { svc, sent } = makeBot({
      pg: pgSpeaking('zh'),
      identity: { consumeAuthToken: jest.fn(async () => 'u-1'), getLinkeonIdByTgUserId: jest.fn(async () => null) },
    });
    await (svc as any).handleMessage(dm('/start tok123', { first_name: 'Li', language_code: 'en' }));
    expect(sent()[0].text).toBe(tgText('zh', 'bind_ok_named', { name: 'Li' }));
  });

  it('привязка не удалась — на языке клиента, с подсказкой про 15 минут', () => {
    const text = TgBotService.bindFailureMessage(new Error('invalid or expired auth token'), { id: 1 }, 'de');
    expect(text).toBe(tgText('de', 'bind_failed', { reason: 'invalid or expired auth token' }));
  });
});

// ─── Группа: ход ───────────────────────────────────────────────────────────────

describe('группа: ход бота — на языке владельца', () => {
  const CFG: any = {
    id: 'cfg-1', owner_user_id: 'u-owner', tg_chat_id: '-100123', display_name: 'Finanzberater',
    voice_reply_mode: 'never', addressing_mode: 'strict', status: 'active', last_reply_at: null,
  };
  const groupMsg = (text: string) => ({ chat: { id: -100123, type: 'supergroup' }, from: { id: 222, language_code: 'ru' }, message_id: 10, text });

  function makeTurn(o: { balance?: number; busy?: boolean; replyFails?: boolean } = {}) {
    const pg = pgSpeaking('de');
    if (o.busy) pg.tryAdvisoryLock = jest.fn(async () => null) as any;
    const router = {
      shouldRespond: jest.fn(async () => true),
      isExplicitlyAddressed: jest.fn(() => true),
      persistUserMessage: jest.fn(async () => {}),
      markAnswerExpected: jest.fn(async () => {}),
      onlySpeakerIs: jest.fn(async () => false),
      generateReply: jest.fn(async (..._a: any[]) => {
        if (o.replyFails) throw new Error('weekly limit');
        return { text: 'Antwort', costUsd: 0.01 };
      }),
      persistAssistantReply: jest.fn(async () => {}),
      consolidateAfterReply: jest.fn(async () => {}),
      persistTurnFailure: jest.fn(async () => {}),
      ownerLanguage: jest.fn(async () => 'de'),
    };
    const billing = {
      getBalance: jest.fn(async () => o.balance ?? 100000),
      recentlyNotifiedZeroBalance: jest.fn(async () => false),
      markZeroBalanceNotified: jest.fn(async () => {}),
      tokensForTurn: jest.fn(() => 36),
      deduct: jest.fn(async () => 99964),
      alertIfExpensiveTurn: jest.fn(async () => {}),
      clearZeroBalanceFlag: jest.fn(async () => {}),
      checkBalanceAlerts: jest.fn(async () => {}),
      notifyOwnerZeroBalance: jest.fn(async () => {}),
      clearOwnerZeroBalanceDm: jest.fn(async () => {}),
    };
    const grammy = {
      getBotUserId: jest.fn(async () => 999),
      sendChatAction: jest.fn(async () => {}),
      sendMessage: jest.fn(async (..._a: any[]) => ({ message_id: 55 })),
      editMessageText: jest.fn(async (..._a: any[]) => {}),
      deleteMessage: jest.fn(async () => {}),
    };
    const svc = new TgBotService(
      pg as any, { getIdentityByLinkeonId: jest.fn(async () => ({ tgUserId: 111 })) } as any, null as any, null as any,
      router as any, { transcribe: jest.fn() } as any, billing as any, { tryHandle: jest.fn(async () => false) } as any,
      { tryHandleLink: jest.fn(async () => false) } as any, grammy as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    const sent = () => grammy.sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    return { svc, grammy, router, sent };
  }

  it('«токены закончились» позвавшему — по-немецки', async () => {
    const { svc, sent } = makeTurn({ balance: 0 });
    await (svc as any).handleChatMessage(groupMsg('Finanzberater, wie viel?'), CFG);
    expect(sent()).toContain(tgText('de', 'zero_balance_group'));
  });

  it('«Минутку» — по-немецки', async () => {
    const { svc, sent } = makeTurn({ busy: true });
    await (svc as any).handleChatMessage(groupMsg('Finanzberater, und?'), CFG);
    expect(sent()).toContain(tgText('de', 'busy'));
  });

  it('статус «Думаю…» — по-немецки', async () => {
    const { svc, sent } = makeTurn();
    await (svc as any).handleChatMessage(groupMsg('Finanzberater, hallo'), CFG);
    expect(sent()).toContain(tgText('de', 'thinking'));
  });

  it('сбой хода — по-немецки', async () => {
    const { svc, grammy } = makeTurn({ replyFails: true });
    await (svc as any).handleChatMessage(groupMsg('Finanzberater, hallo'), CFG).catch(() => {});
    const edits = grammy.editMessageText.mock.calls.map((c: any[]) => String(c[2]));
    expect(edits).toContain(tgText('de', 'turn_failed', { reason: 'weekly limit' }));
  });

  it('подписи шагов — на языке, по умолчанию русские', () => {
    expect(TgBotService.toolStatusLabel('Read', 'de')).toBe(tgText('de', 'tool_read'));
    expect(TgBotService.toolStatusLabel('WebSearch', 'zh')).toBe(tgText('zh', 'tool_web_search'));
    expect(TgBotService.toolStatusLabel('Read')).toBe(tgText('ru', 'tool_read'));
  });

  it('ответ не доставился — по-немецки', async () => {
    const { svc, grammy } = makeTurn();
    grammy.sendMessage.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ message_id: 1 });
    await expect(svc.deliverReplyText(-100123, 10, 'Antwort', 'de')).rejects.toThrow('boom');
    expect(String((grammy.sendMessage.mock.calls[1] as any[])[1])).toBe(tgText('de', 'delivery_failed'));
  });
});

// ─── Группа: привязка и выход ──────────────────────────────────────────────────

describe('группа: привязка и выход — на языке владельца', () => {
  it('приветствие после привязки — на языке владельца', async () => {
    const claim = { claim: jest.fn(async () => ({ ownerUserId: 'u-1', configId: 'c', displayName: 'Fin' })) };
    const { svc, sent } = makeBot({ pg: pgSpeaking('de'), claim });
    await (svc as any).handleMessage({ chat: { id: -100, type: 'supergroup', title: 'T' }, from: { id: 7 }, message_id: 1, text: '/start@LinkeonAgentBot tok' });
    expect(sent()[0].text).toBe(tgText('de', 'claim_hello', { name: 'Fin', bot: 'LinkeonAgentBot' }));
  });

  it('бота удалили из группы — владельцу на его языке', async () => {
    const pg = pgSpeaking('fr');
    const configs = { getActiveByTgChatId: jest.fn(async () => ({ id: 'c', owner_user_id: 'u-1', display_name: 'Fin', tg_chat_title: 'Équipe' })) };
    const { svc, sent } = makeBot({ pg, configs, identity: { getIdentityByLinkeonId: jest.fn(async () => ({ tgUserId: 111 })) } });
    await (svc as any).handleMyChatMember({ chat: { id: -100 }, new_chat_member: { status: 'kicked' } });
    expect(sent()[0].text).toBe(tgText('fr', 'bot_removed', { name: 'Fin', group: 'Équipe' }));
  });
});

// ─── Группа: команды ───────────────────────────────────────────────────────────

describe('команды в группе — на языке владельца, меню — бесплатно', () => {
  const CFG: any = { id: 'c1', display_name: 'Fin_<A>', addressing_mode: 'strict', owner_user_id: 'u-owner' };
  const groupMsg = (text: string) => ({ chat: { id: -100 }, from: { id: 2 }, message_id: 3, text });
  function makeCommands(lang: string, extra?: (sql: string) => any) {
    const grammy = { sendMessage: jest.fn(async () => ({})), answerCallbackQuery: jest.fn(async () => ({})) };
    const pg = pgSpeaking(lang, extra);
    const svc = new TgCommandsService(pg as any, grammy as any, { getBalance: jest.fn(async () => 5) } as any,
      { getIdentityByLinkeonId: jest.fn(async () => null) } as any,
      { getAgents: jest.fn(async () => Array.from({ length: 20 }, (_, i) => ({ name: `A${i}` }))), changeAgent: jest.fn(async () => {}) } as any,
      { getActiveByTgChatId: jest.fn(async () => ({ id: 'dm-cfg' })) } as any);
    const sent = () => grammy.sendMessage.mock.calls.map((c: any[]) => ({ text: String(c[1]), opts: c[2] ?? {} }));
    return { svc, grammy, pg, sent };
  }

  it('/help — по-французски, имя экранировано', async () => {
    const { svc, sent } = makeCommands('fr');
    expect(await svc.tryHandle(CFG, groupMsg('/help'))).toBe(true);
    expect(sent()[0].text).toBe(tgText('fr', 'group_help', { name: escapeHtml(CFG.display_name), mode: tgText('fr', 'mode_strict') }));
  });

  it('не владелец — «только владельцу» по-французски', async () => {
    const { svc, sent } = makeCommands('fr');
    await svc.tryHandle(CFG, groupMsg('/balance'));
    expect(sent()[0].text).toBe(tgText('fr', 'owner_only'));
  });

  it('/assistants@бот и /language в группе — бесплатный ответ «это в личке», а не ход модели', async () => {
    const a = makeCommands('es');
    expect(await a.svc.tryHandle(CFG, groupMsg('/assistants@LinkeonAgentBot'))).toBe(true);
    expect(a.sent()[0].text).toBe(tgText('es', 'dm_only', { bot: 'LinkeonAgentBot' }));
    const b = makeCommands('es');
    expect(await b.svc.tryHandle(CFG, groupMsg('/language'))).toBe(true);
    expect(b.sent()[0].text).toBe(tgText('es', 'dm_only', { bot: 'LinkeonAgentBot' }));
  });

  it('/start@бот без кода в группе — справка, а не ход модели', async () => {
    const { svc, sent } = makeCommands('de');
    expect(await svc.tryHandle(CFG, groupMsg('/start@LinkeonAgentBot'))).toBe(true);
    expect(sent()[0].text).toBe(tgText('de', 'group_help', { name: escapeHtml(CFG.display_name), mode: tgText('de', 'mode_strict') }));
  });

  it('выбор языка: подтверждение — уже на новом языке', async () => {
    const { svc, sent } = makeCommands('ru');
    await svc.handleLanguageCallback({ id: 'cb', data: 'lang:de', message: { chat: { id: 42 } } }, 'u-1');
    expect(sent()[0].text).toBe(tgText('de', 'language_set', { language: 'Deutsch' }));
  });

  it('/assistants в личке — вопрос и кнопки листания на языке владельца', async () => {
    const { svc, sent } = makeCommands('es', (sql) => (/preferred_agent/.test(sql) ? { rows: [{ preferred_agent: 'A1' }] } : { rows: [] }));
    await svc.handleAssistants({ chat: { id: 42 }, from: { id: 42 } }, 'u-1');
    expect(sent()[0].text).toBe(tgText('es', 'assistants_current', { agent: 'A1' }));
    const nav = sent()[0].opts.reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(nav).toContain(tgText('es', 'nav_next'));
  });

  it('смена ассистента: отметка в ленте — на языке владельца', async () => {
    const { svc, pg } = makeCommands('de');
    await svc.handleAgentCallback({ id: 'cb', data: 'agent:A1', message: { chat: { id: 42 } }, from: { id: 42 } }, 'u-1');
    const insert = pg.query.mock.calls.find((c: any[]) => /INSERT INTO tg_bot_messages/.test(String(c[0]))) as any[];
    expect(insert[1][3]).toBe(tgText('de', 'assistant_switched_note', { agent: 'A1' }));
  });
});

// ─── Владельцу о балансе ───────────────────────────────────────────────────────

describe('владельцу о балансе — на его языке', () => {
  it('ноль — по-немецки', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const redis = { setNx: jest.fn(async () => true), del: jest.fn(async () => {}) };
    const svc = new TgBillingService(pgSpeaking('de') as any, grammy as any, redis as any);
    (svc as any).logger = quiet;
    await svc.notifyOwnerZeroBalance('u-1', 111);
    expect((grammy.sendMessage.mock.calls[0] as any[])[1]).toBe(tgText('de', 'zero_balance_owner'));
  });

  it('мало токенов — по-французски, с французскими разрядами', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const pg = pgSpeaking('fr', (sql) => (/RETURNING/.test(sql) ? { rows: [{ id: 'c1' }] } : { rows: [] }));
    const svc = new TgBillingService(pg as any, grammy as any, undefined);
    (svc as any).logger = quiet;
    jest.spyOn(svc, 'getBalance').mockResolvedValue(500);
    await svc.checkBalanceAlerts('c1', 'u-1', 111);
    expect((grammy.sendMessage.mock.calls[0] as any[])[1]).toBe(tgText('fr', 'low_balance', { balance: formatTgNumber('fr', 500) }));
  });
});

// ─── Встречи и видео ───────────────────────────────────────────────────────────

describe('встречи и видео — на языке владельца', () => {
  function makeMeeting(lang: string, agent: any = { id: 7, name: 'Roman' }) {
    const grammy = { sendMessage: jest.fn(async () => ({})), answerCallbackQuery: jest.fn(async () => ({})) };
    const pg = pgSpeaking(lang, (sql) => (/FROM ai_profiles_consolidated p/.test(sql) ? { rows: agent ? [agent] : [] } : { rows: [] }));
    const svc = new TgMeetingService(pg as any, grammy as any, { join: jest.fn() } as any, {} as any, {} as any, {} as any);
    (svc as any).logger = quiet;
    jest.spyOn(svc as any, 'lookup').mockResolvedValue({ title: 'Plan' });
    return { svc, grammy };
  }

  it('приглашение: «зайдёт во встречу» и кнопка — по-испански', async () => {
    const { svc, grammy } = makeMeeting('es');
    await svc.tryHandleLink(-100, 'https://zoom.us/j/123456789', 'u-1');
    const [, text, opts] = grammy.sendMessage.mock.calls[0] as any[];
    expect(text).toContain(tgText('es', 'meeting_who_agent', { agent: 'Roman' }));
    expect(opts.reply_markup.inline_keyboard[0][0].text).toBe(tgText('es', 'meeting_join'));
  });

  it('кнопку нажали, а ассистент не выбран — подсказка по-испански', async () => {
    const { svc, grammy } = makeMeeting('es', null);
    await svc.handleJoinCallback({ id: 'cb', data: 'meet:linkeon:abc', message: { chat: { id: -100 } } }, 'u-1');
    expect(grammy.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: tgText('es', 'meeting_pick_assistant') });
  });

  it('видео не получилось — по-немецки (язык — через конфиг задачи)', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})), sendChatAction: jest.fn(async () => {}) };
    const pg = pgSpeaking('de');
    const svc = new TgVideoDispatchService(pg as any, grammy as any);
    (svc as any).logger = quiet;
    await (svc as any).deliver({ job_id: 'j', tg_chat_id: '-100', tg_reply_to_message_id: 5, status: 'failed', video_url: null, owner_user_id: 'u-1' });
    expect((grammy.sendMessage.mock.calls[0] as any[])[1]).toBe(tgText('de', 'video_failed'));
  });

  it('выборка готовых видео берёт и владельца — иначе языка не узнать', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new TgVideoDispatchService(pg as any, {} as any);
    await (svc as any).tick();
    expect(String((pg.query.mock.calls[0] as any[])[0])).toMatch(/owner_user_id/);
  });
});

// ─── Меню команд ───────────────────────────────────────────────────────────────

describe('меню команд: своё для личек и групп, на каждом языке', () => {
  it('в группе нет /assistants и /language — их там не меняют', () => {
    const groups = tgCommandMenus().filter((m) => m.scope === 'all_group_chats');
    expect(groups.length).toBe(8);
    for (const m of groups) expect(m.commands.map((c) => c.command)).toEqual(['help', 'balance', 'silent', 'resume']);
  });

  it('в личке — полный набор; без языка — английский', () => {
    const privates = tgCommandMenus().filter((m) => m.scope === 'all_private_chats');
    expect(privates.length).toBe(8);
    const def = privates.find((m) => !m.language_code)!;
    expect(def.commands.find((c) => c.command === 'help')!.description).toBe(tgText('en', 'cmd_help'));
    const de = privates.find((m) => m.language_code === 'de')!;
    expect(de.commands.map((c) => c.command)).toEqual(['assistants', 'language', 'balance', 'silent', 'resume', 'help']);
  });

  it('клиент Telegram регистрирует каждое меню со своим scope и языком', async () => {
    const client = new TgGrammyClient();
    const setMyCommands = jest.fn(async () => true);
    (client as any).bot = { api: { setMyCommands } };
    (client as any).logger = quiet;
    await (client as any).registerCommandMenus();
    expect(setMyCommands).toHaveBeenCalledTimes(tgCommandMenus().length);
    expect(setMyCommands).toHaveBeenCalledWith(expect.any(Array), { scope: { type: 'all_group_chats' }, language_code: 'fr' });
    expect(setMyCommands).toHaveBeenCalledWith(expect.any(Array), { scope: { type: 'all_private_chats' } });
  });

  it('сбой одного меню не мешает остальным', async () => {
    const client = new TgGrammyClient();
    const setMyCommands = jest.fn(async () => true).mockRejectedValueOnce(new Error('Too Many Requests'));
    (client as any).bot = { api: { setMyCommands } };
    (client as any).logger = quiet;
    await expect((client as any).registerCommandMenus()).resolves.toBeUndefined();
    expect(setMyCommands).toHaveBeenCalledTimes(tgCommandMenus().length);
  });
});

// ─── Группа стала супергруппой ─────────────────────────────────────────────────

describe('группа → супергруппа: бот переезжает вместе с ней', () => {
  it('в старой группе пришёл migrate_to_chat_id — конфиг переезжает на новый id', async () => {
    const configs = { moveToChat: jest.fn(async () => {}) };
    const { svc } = makeBot({ configs });
    const chat = jest.spyOn(svc as any, 'handleChatMessage').mockResolvedValue(undefined);
    await (svc as any).handleMessage({ chat: { id: -4001, type: 'group' }, from: { id: 1 }, message_id: 9, migrate_to_chat_id: -1004001 });
    expect(configs.moveToChat).toHaveBeenCalledWith(-4001, -1004001);
    expect(chat).not.toHaveBeenCalled();
  });

  it('в новой супергруппе пришёл migrate_from_chat_id — то же (что раньше дойдёт)', async () => {
    const configs = { moveToChat: jest.fn(async () => {}) };
    const { svc } = makeBot({ configs });
    await (svc as any).handleMessage({ chat: { id: -1004001, type: 'supergroup' }, from: { id: 1 }, message_id: 1, migrate_from_chat_id: -4001 });
    expect(configs.moveToChat).toHaveBeenCalledWith(-4001, -1004001);
  });

  it('moveToChat: на новом id уже свой бот (уникальный индекс) — не роняем вебхук', async () => {
    const pg = { query: jest.fn(async () => { throw Object.assign(new Error('duplicate key value'), { code: '23505' }); }) };
    const svc = new TgConfigService(pg as any, {} as any);
    (svc as any).logger = quiet;
    await expect(svc.moveToChat(-4001, -1004001)).resolves.toBeUndefined();
  });
});
