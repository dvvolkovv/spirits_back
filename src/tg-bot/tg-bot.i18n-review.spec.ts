import { TgBotService } from './tg-bot.service';
import { TgCommandsService } from './tg-commands.service';
import { TgConfigService } from './tg-config.service';
import { TgIdentityService } from './tg-identity.service';
import { TgClaimService } from './tg-claim.service';
import { TgMeetingService } from './tg-meeting.service';
import { tgText, tgCommandMenus, ownerTgLanguage } from './tg-i18n';

/**
 * Ревью служебных текстов на семи языках (14.10.2026):
 *   - язык привязанного — язык профиля (его заполняет сам кабинет при входе),
 *     язык клиента Telegram — только тем, у кого аккаунта нет: иначе в одной
 *     личке ответ шёл на языке клиента, а фоновые сообщения — по-русски;
 *   - сырой текст ошибок («claim token не принадлежит…», «Недостаточно
 *     токенов») больше не попадает в переведённые сообщения;
 *   - новая ссылка гасит старые, а к группе подключается только бот, который
 *     ещё ни к одной не подключён;
 *   - переезд группы в супергруппу — одним запросом и вместе со всей историей
 *     чата.
 */

const quiet = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };
const OLD_USERNAME = process.env.TG_BOT_USERNAME;
beforeAll(() => { process.env.TG_BOT_USERNAME = 'LinkeonAgentBot'; });
afterAll(() => {
  if (OLD_USERNAME === undefined) delete process.env.TG_BOT_USERNAME;
  else process.env.TG_BOT_USERNAME = OLD_USERNAME;
});

const LANG_SQL = /profile_data->>'language'/;
function pgSpeaking(lang: string | null, extra: (sql: string, p?: any[]) => any = () => ({ rows: [] })) {
  return {
    query: jest.fn(async (sql: string, p?: any[]) =>
      LANG_SQL.test(sql) ? { rows: lang ? [{ language: lang }] : [] } : extra(sql, p)),
    tryAdvisoryLock: jest.fn(async () => ({ release: jest.fn(async () => {}) })),
  };
}
const langQueries = (pg: { query: jest.Mock }) => pg.query.mock.calls.filter((c: any[]) => LANG_SQL.test(String(c[0]))).length;

function makeBot(o: { pg?: any; identity?: any; claim?: any; configs?: any; billing?: any; commands?: any; router?: any; meetings?: any } = {}) {
  const grammy = {
    getBotUserId: jest.fn(async () => 999),
    sendChatAction: jest.fn(async () => {}),
    sendMessage: jest.fn(async (..._a: any[]) => ({ message_id: 55 })),
    editMessageText: jest.fn(async () => {}),
    deleteMessage: jest.fn(async () => {}),
    leaveChat: jest.fn(async () => true),
    answerCallbackQuery: jest.fn(async () => ({})),
  };
  const blog = { handleCaseCommand: jest.fn(async () => false), handleReplyEdit: jest.fn(async () => false) };
  const svc = new TgBotService(
    (o.pg ?? pgSpeaking(null)) as any, (o.identity ?? { getLinkeonIdByTgUserId: jest.fn(async () => null) }) as any,
    (o.claim ?? null) as any, (o.configs ?? null) as any, (o.router ?? null) as any, { transcribe: jest.fn() } as any,
    (o.billing ?? null) as any, (o.commands ?? null) as any, (o.meetings ?? null) as any, grammy as any,
    null as any, null as any, blog as any,
  );
  (svc as any).logger = quiet;
  const sent = () => grammy.sendMessage.mock.calls.map((c: any[]) => String(c[1]));
  return { svc, grammy, sent };
}

function turnDeps(o: { balance?: number; should?: boolean } = {}) {
  return {
    router: {
      shouldRespond: jest.fn(async () => o.should ?? true),
      isExplicitlyAddressed: jest.fn(() => o.should ?? true),
      persistUserMessage: jest.fn(async () => {}),
      markAnswerExpected: jest.fn(async () => {}),
      onlySpeakerIs: jest.fn(async () => false),
      generateReply: jest.fn(async (..._a: any[]) => ({ text: 'ответ', costUsd: 0.01 })),
      persistAssistantReply: jest.fn(async () => {}),
      consolidateAfterReply: jest.fn(async () => {}),
      persistTurnFailure: jest.fn(async () => {}),
      ownerLanguage: jest.fn(async () => 'ru'),
    },
    billing: {
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
    },
    commands: { tryHandle: jest.fn(async () => false) },
    meetings: { tryHandleLink: jest.fn(async () => false) },
    identity: { getIdentityByLinkeonId: jest.fn(async () => ({ tgUserId: 111 })) },
  };
}
const GROUP_CFG: any = {
  id: 'cfg-g', owner_user_id: 'u-owner', tg_chat_id: '-100123', display_name: 'Финансист',
  voice_reply_mode: 'never', addressing_mode: 'strict', status: 'active', last_reply_at: null,
};
const DM_CFG: any = { ...GROUP_CFG, id: 'cfg-dm', tg_chat_id: '42', addressing_mode: 'always', display_name: 'Linkeon' };

// ─── Язык ─────────────────────────────────────────────────────────────────────

describe('язык: привязанному — профиль, клиент Telegram — только без аккаунта', () => {
  it('ownerTgLanguage: есть аккаунт — язык клиента не смотрим (профиль пуст → русский)', async () => {
    const pg = pgSpeaking(null);
    expect(await ownerTgLanguage(pg as any, 'u-1', 'es')).toBe('ru');
  });

  it('привязанный без языка в профиле, Telegram по-испански: /balance — по-русски, как и фоновые сообщения', async () => {
    const { svc, sent } = makeBot({
      identity: { getLinkeonIdByTgUserId: jest.fn(async () => 'u-1') },
      billing: { getBalance: jest.fn(async () => 5) },
    });
    await (svc as any).handleMessage({ chat: { id: 42, type: 'private' }, from: { id: 42, language_code: 'es' }, text: '/balance' });
    expect(sent()[0]).toBe(tgText('ru', 'balance', { balance: '5' }));
  });

  it('ход в личке: профиль пуст, клиент es — «Думаю…» по-русски', async () => {
    const d = turnDeps();
    const { svc, sent } = makeBot({ ...d });
    await (svc as any).handleChatMessage({ chat: { id: 42, type: 'private' }, from: { id: 42, language_code: 'es' }, message_id: 1, text: 'привет' }, DM_CFG);
    expect(sent()).toContain(tgText('ru', 'thinking'));
  });

  it('группа: профиль пуст, участник с fr — по-русски', async () => {
    const d = turnDeps();
    const { svc, sent } = makeBot({ ...d });
    await (svc as any).handleChatMessage({ chat: { id: -100123, type: 'supergroup' }, from: { id: 7, language_code: 'fr' }, message_id: 1, text: 'Финансист, привет' }, GROUP_CFG);
    expect(sent()).toContain(tgText('ru', 'thinking'));
  });

  it('реплика группы, на которую бот не отвечает, — язык из базы не читается', async () => {
    const d = turnDeps({ should: false });
    const pg = pgSpeaking('de');
    const { svc } = makeBot({ ...d, pg });
    await (svc as any).handleChatMessage({ chat: { id: -100123, type: 'supergroup' }, from: { id: 7 }, message_id: 1, text: 'просто болтаем' }, GROUP_CFG);
    expect(langQueries(pg)).toBe(0);
  });

  it('отвеченный ход — язык читается ровно один раз', async () => {
    const d = turnDeps();
    const pg = pgSpeaking('de');
    const { svc } = makeBot({ ...d, pg });
    await (svc as any).handleChatMessage({ chat: { id: -100123, type: 'supergroup' }, from: { id: 7 }, message_id: 1, text: 'Финансист, привет' }, GROUP_CFG);
    expect(langQueries(pg)).toBe(1);
  });

  it('identity лёг — /help в личке всё равно уходит, на языке клиента', async () => {
    const { svc, sent } = makeBot({ identity: { getLinkeonIdByTgUserId: jest.fn(async () => { throw new Error('Connection terminated'); }) } });
    await (svc as any).handleMessage({ chat: { id: 42, type: 'private' }, from: { id: 42, language_code: 'fr' }, text: '/help' });
    expect(sent()[0]).toBe(tgText('fr', 'dm_help'));
  });
});

// ─── Причины ошибок ───────────────────────────────────────────────────────────

describe('причины ошибок — своими словами на языке человека, без сырого текста', () => {
  const groupClaim = { chat: { id: -100, type: 'supergroup', title: 'T' }, from: { id: 7 }, message_id: 1, text: '/start@LinkeonAgentBot tok' };
  const claimFails = (claimFailure?: string, message = 'raw internal text') => ({
    claim: jest.fn(async () => { throw Object.assign(new Error(message), claimFailure ? { claimFailure } : {}); }),
  });
  const deps = (claim: any) => ({
    pg: pgSpeaking('de'),
    claim,
    configs: { getActiveByTgChatId: jest.fn(async () => null) },
    identity: { getLinkeonIdByTgUserId: jest.fn(async () => 'u-1') },
  });

  it.each([
    ['expired', 'claim_expired'],
    ['wrong_account', 'claim_wrong_account'],
    ['group_taken', 'claim_group_taken'],
    ['already_connected', 'claim_already_connected'],
  ] as const)('привязка группы не удалась (%s) — свой текст на языке человека', async (failure, key) => {
    const { svc, grammy } = makeBot(deps(claimFails(failure)));
    await (svc as any).handleMessage(groupClaim);
    expect(grammy.sendMessage).toHaveBeenCalledWith(7, tgText('de', key));
  });

  it('незнакомая причина — общий текст, сырое сообщение в чат не уходит', async () => {
    const { svc, sent } = makeBot(deps(claimFails(undefined, 'claim token не принадлежит этому Telegram-аккаунту')));
    await (svc as any).handleMessage(groupClaim);
    expect(sent()).toContain(tgText('de', 'claim_failed'));
    expect(sent().join('\n')).not.toMatch(/claim token|raw internal/);
  });

  it('сбой хода — без технической причины, причина — только в историю', async () => {
    const d = turnDeps();
    const { svc, grammy } = makeBot({ ...d, pg: pgSpeaking('de') });
    await (svc as any).recordTurnFailure(GROUP_CFG, -100123, 77, new Error('weekly limit'), 'de');
    expect(grammy.editMessageText).toHaveBeenCalledWith(-100123, 77, tgText('de', 'turn_failed'));
    expect(d.router.persistTurnFailure).toHaveBeenCalledWith(GROUP_CFG, expect.stringContaining('weekly limit'));
  });

  it('вложение не приложилось — без причины («Недостаточно токенов» по-русски не уходит)', async () => {
    const { svc, sent } = makeBot({ pg: pgSpeaking('en') });
    jest.spyOn(svc as any, 'dispatchOutgoingMarker').mockRejectedValue(new Error('Недостаточно токенов'));
    await (svc as any).deliverOutgoingMarkers(GROUP_CFG, { chat: { id: -100123 }, from: { id: 7 }, message_id: 1 }, [{ kind: 'image', value: 'x' }], 'en');
    expect(sent()).toEqual([tgText('en', 'attach_failed')]);
  });

  it('привязка Telegram не удалась — без сырой причины', () => {
    const text = TgBotService.bindFailureMessage(new Error('invalid or expired auth token'), { id: 1 }, 'de');
    expect(text).toBe(tgText('de', 'bind_failed'));
    expect(text).not.toMatch(/invalid/);
  });

  it('личка: ноль — владельцу его собственный текст, а не групповой «у владельца закончились»', async () => {
    const d = turnDeps({ balance: 0 });
    const { svc, sent } = makeBot({ ...d });
    await (svc as any).handleChatMessage({ chat: { id: 42, type: 'private' }, from: { id: 42 }, message_id: 1, text: 'привет' }, DM_CFG);
    expect(sent()).toContain(tgText('ru', 'zero_balance_owner'));
    expect(sent()).not.toContain(tgText('ru', 'zero_balance_group'));
  });
});

// ─── Ссылки ───────────────────────────────────────────────────────────────────

describe('ссылки: новая гасит старые; к группе подключается только неподключённый бот', () => {
  it('reissueClaim сначала гасит прежние ссылки этого бота, потом выдаёт новую', async () => {
    const pg = { query: jest.fn(async (sql: string) => {
      if (/SELECT \* FROM tg_bot_configs WHERE id/.test(sql)) return { rows: [{ id: 'c1', status: 'pending' }] };
      if (/RETURNING \*/.test(sql)) return { rows: [{ id: 'c1', status: 'pending' }] };
      if (/INSERT INTO tg_claim_tokens/.test(sql)) return { rows: [{ token: 'new-tok' }] };
      return { rows: [], rowCount: 2 };
    }) };
    const svc = new TgConfigService(pg as any, {} as any);
    await svc.reissueClaim('c1', 'u-1');
    const sqls = pg.query.mock.calls.map((c: any[]) => String(c[0]));
    const revoke = sqls.findIndex((q) => /UPDATE tg_claim_tokens SET consumed_at = now\(\)[\s\S]*config_id = \$1[\s\S]*kind = 'claim'[\s\S]*consumed_at IS NULL/.test(q));
    const insert = sqls.findIndex((q) => /INSERT INTO tg_claim_tokens/.test(q));
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeLessThan(insert);
  });

  it('createAuthToken гасит прежние ссылки привязки владельца — утёкшая старая ссылка больше не работает', async () => {
    const pg = { query: jest.fn(async (sql: string) => (/INSERT/.test(sql) ? { rows: [{ token: 't' }] } : { rows: [] })) };
    const svc = new TgIdentityService(pg as any);
    await svc.createAuthToken('u-1');
    const sqls = pg.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(sqls[0]).toMatch(/UPDATE tg_claim_tokens SET consumed_at = now\(\)[\s\S]*owner_user_id = \$1[\s\S]*kind = 'auth'[\s\S]*consumed_at IS NULL/);
    expect(sqls[1]).toMatch(/INSERT INTO tg_claim_tokens/);
  });

  function makeClaim(o: { token?: any; owner?: number | null; conflict?: boolean }) {
    const pg = { query: jest.fn(async (sql: string) => {
      if (/FROM tg_claim_tokens t/.test(sql)) return { rows: o.token ? [o.token] : [] };
      if (/id != \$2/.test(sql)) return { rows: o.conflict ? [{ id: 'other' }] : [] };
      return { rows: [] };
    }) };
    const identity = { getIdentityByLinkeonId: jest.fn(async () => (o.owner === null ? null : { tgUserId: o.owner ?? 7 })) };
    return { svc: new TgClaimService(pg as any, identity as any), pg };
  }
  const TOKEN = { owner_user_id: 'u-1', config_id: 'c1', display_name: 'Fin', status: 'pending' };

  it.each([
    ['expired', { token: null }],
    ['wrong_account', { token: TOKEN, owner: 8 }],
    ['group_taken', { token: TOKEN, conflict: true }],
    ['already_connected', { token: { ...TOKEN, status: 'active' } }],
  ] as const)('claim: отказ «%s» несёт код причины', async (failure, o) => {
    const { svc } = makeClaim(o as any);
    await expect(svc.claim('tok', 7, -100, 'T')).rejects.toMatchObject({ claimFailure: failure });
  });

  it('claim: бот уже подключён к другой группе — его не переносит (раньше — молча утаскивало)', async () => {
    const { svc, pg } = makeClaim({ token: { ...TOKEN, status: 'active' } });
    await svc.claim('tok', 7, -100, 'T').catch(() => {});
    const moved = pg.query.mock.calls.some((c: any[]) => /UPDATE tg_bot_configs SET tg_chat_id/.test(String(c[0])));
    expect(moved).toBe(false);
  });
});

// ─── Группа, меню, переезд ────────────────────────────────────────────────────

describe('группа: голый /start, меню, переезд', () => {
  const CFG: any = { id: 'c1', display_name: 'Fin', addressing_mode: 'strict', owner_user_id: 'u-owner' };
  const groupMsg = (text: string) => ({ chat: { id: -100 }, from: { id: 2 }, message_id: 3, text });
  function makeCommands() {
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const svc = new TgCommandsService(pgSpeaking(null) as any, grammy as any, {} as any,
      { getIdentityByLinkeonId: jest.fn(async () => null) } as any, {} as any, {} as any);
    return { svc, grammy };
  }

  it('голый /start в группе — чаще чужому боту: перехватываем молча, без справки и без хода модели', async () => {
    const { svc, grammy } = makeCommands();
    expect(await svc.tryHandle(CFG, groupMsg('/start'))).toBe(true);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('наш /start@бот без кода — справка (контроль)', async () => {
    const { svc, grammy } = makeCommands();
    expect(await svc.tryHandle(CFG, groupMsg('/start@LinkeonAgentBot'))).toBe(true);
    expect(grammy.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('меню по умолчанию — английское групповое: если меню по чатам не встанет, /assistants в группах не всплывёт', () => {
    const def = tgCommandMenus().filter((m) => m.scope === 'default');
    expect(def).toHaveLength(1);
    expect(def[0].commands.map((c) => c.command)).toEqual(['help', 'balance', 'silent', 'resume']);
    expect(def[0].language_code).toBeUndefined();
  });

  it('служебное сообщение о переезде от GroupAnonymousBot (is_bot) — переезд всё равно случается', async () => {
    const configs = { moveToChat: jest.fn(async () => {}) };
    const { svc } = makeBot({ configs });
    await (svc as any).handleMessage({ chat: { id: -1004001, type: 'supergroup' }, from: { id: 1087968824, is_bot: true }, message_id: 1, migrate_from_chat_id: -4001 });
    expect(configs.moveToChat).toHaveBeenCalledWith(-4001, -1004001);
  });

  it('moveToChat — одним запросом: конфиг, вся история чата (и прежних ботов) и ждущие видео', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [{ id: 'cfg-1' }] })) };
    const svc = new TgConfigService(pg as any, {} as any);
    (svc as any).logger = quiet;
    await svc.moveToChat(-4001, -1004001);
    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(params).toEqual([-4001, -1004001]);
    expect(sql).toMatch(/UPDATE tg_bot_configs SET tg_chat_id = \$2[\s\S]*WHERE tg_chat_id = \$1 AND status IN \('active','silent'\)/);
    expect(sql).toMatch(/UPDATE tg_bot_messages SET tg_chat_id = \$2\s+WHERE tg_chat_id = \$1 AND EXISTS/);
    expect(sql).not.toMatch(/config_id = \$3/);
    expect(sql).toMatch(/UPDATE tg_bot_video_jobs SET tg_chat_id = \$2[\s\S]*delivery_status = 'pending'/);
  });
});

// ─── Мелочи ───────────────────────────────────────────────────────────────────

describe('мелочи ревью', () => {
  it('листание ассистентов отвечает на нажатие — «часики» на кнопке не крутятся', async () => {
    const commands = { handleAssistants: jest.fn(async () => {}) };
    const { svc, grammy } = makeBot({ commands, identity: { getLinkeonIdByTgUserId: jest.fn(async () => 'u-1') } });
    await (svc as any).handleCallbackQuery({ id: 'cb-1', data: 'agents_page:1', from: { id: 42 }, message: { chat: { id: 42 } } });
    expect(grammy.answerCallbackQuery).toHaveBeenCalledWith('cb-1', {});
    expect(commands.handleAssistants).toHaveBeenCalledWith(expect.anything(), 'u-1', 1);
  });

  it('приглашение на встречу: точка — из каталога, по-китайски «。»', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})) };
    const pg = pgSpeaking('zh', (sql) => (/FROM ai_profiles_consolidated p/.test(sql) ? { rows: [] } : { rows: [] }));
    const svc = new TgMeetingService(pg as any, grammy as any, {} as any, {} as any, {} as any, {} as any);
    (svc as any).logger = quiet;
    jest.spyOn(svc as any, 'lookup').mockResolvedValue({ title: 'Plan' });
    await svc.tryHandleLink(-100, 'https://zoom.us/j/123456789', 'u-1');
    const text = String((grammy.sendMessage.mock.calls[0] as any[])[1]);
    expect(text.endsWith(tgText('zh', 'meeting_who'))).toBe(true);
    expect(tgText('zh', 'meeting_who').endsWith('。')).toBe(true);
    expect(text).not.toMatch(/\.$/);
  });
});
