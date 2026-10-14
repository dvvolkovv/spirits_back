import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TgBotService } from './tg-bot.service';
import { TgRouterService } from './tg-router.service';

/**
 * БОТ ГОВОРИТ В ГРУППЕ, ТОЛЬКО КОГДА ОТВЕЧАЕТ.
 *
 * Найдено ревью 13.10.2026 (карточка «что это за бот» в Студии обещает режим
 * «только когда к нему обращаются» и /silent «бот замолкает»). Две реплики бота
 * уходили в группу ДО решения, отвечать ли, — значит, и в режиме «по
 * обращению», и у замолчанного бота (getActiveByTgChatId берёт и 'silent'):
 *   - эхо расшифровки «🎙️ «…»» на КАЖДОЕ голосовое группы;
 *   - «⚠️ У владельца закончились токены» на любое сообщение группы, раз в
 *     10 минут;
 *   - «⏳ Минутку — заканчиваю предыдущий запрос» на любое сообщение, пока идёт
 *     чужой ход, — вместе с отметкой «ждём ответа», из-за которой мониторинг
 *     потом ложно кричал «бот молчит».
 * Эхо нужно, чтобы видеть, что бот услышал, — только когда он отвечает.
 * Предупреждение о нуле и «Минутку» объясняют, почему бот не ответил, — только
 * тому, кто его позвал.
 */

const quiet = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };

const OLD_USERNAME = process.env.TG_BOT_USERNAME;
beforeAll(() => { process.env.TG_BOT_USERNAME = 'LinkeonAgentBot'; });
afterAll(() => {
  if (OLD_USERNAME === undefined) delete process.env.TG_BOT_USERNAME;
  else process.env.TG_BOT_USERNAME = OLD_USERNAME;
});

function makeRouter() {
  const router = new TgRouterService({} as any, null as any, null as any, null as any, null as any);
  (router as any).logger = quiet;
  return router;
}

// ─── решение «к боту обратились явно» ────────────────────────────────────────

describe('TgRouterService.isExplicitlyAddressed', () => {
  const router = makeRouter();
  const cfg = (over: any = {}) =>
    ({ display_name: 'Финансист', addressing_mode: 'strict', status: 'active', ...over }) as any;
  const said = (text: string, replyToFromBot = false) => ({ text, replyToFromBot });

  it('«на каждое сообщение» — обращено всё', () => {
    expect(router.isExplicitlyAddressed(cfg({ addressing_mode: 'always' }), said('просто болтаем'))).toBe(true);
  });

  it('«по обращению»: имя в тексте, упоминание, ответ на сообщение бота — обращено', () => {
    expect(router.isExplicitlyAddressed(cfg(), said('Финансист, сколько осталось?'))).toBe(true);
    expect(router.isExplicitlyAddressed(cfg(), said('@LinkeonAgentBot привет'))).toBe(true);
    expect(router.isExplicitlyAddressed(cfg(), said('ага', true))).toBe(true);
  });

  it('«по обращению»: обычная реплика группы — не обращено', () => {
    expect(router.isExplicitlyAddressed(cfg(), said('встречаемся в восемь'))).toBe(false);
  });

  it('«умно» без явного обращения — не обращено: гейт модели здесь не зовётся', () => {
    const gate = jest.spyOn(TgRouterService.prototype as any, 'smartGate');
    expect(router.isExplicitlyAddressed(cfg({ addressing_mode: 'smart' }), said('встречаемся в восемь'))).toBe(false);
    expect(router.isExplicitlyAddressed(cfg({ addressing_mode: 'smart' }), said('Финансист, глянь'))).toBe(true);
    expect(gate).not.toHaveBeenCalled();
    gate.mockRestore();
  });

  it('регистр не важен: упоминание, имя и команда', () => {
    expect(router.isExplicitlyAddressed(cfg(), said('@linkeonagentbot глянь'))).toBe(true);
    expect(router.isExplicitlyAddressed(cfg(), said('ФИНАНСИСТ, сколько?'))).toBe(true);
    expect(router.isExplicitlyAddressed(cfg(), said('/HELP'))).toBe(true);
  });

  it('пустое имя бота не делает обращением каждую реплику', () => {
    expect(router.isExplicitlyAddressed(cfg({ display_name: '' }), said('встречаемся в восемь'))).toBe(false);
  });

  it('замолчанный /silent — не обращено ни в каком режиме', () => {
    expect(router.isExplicitlyAddressed(cfg({ status: 'silent' }), said('Финансист, ты тут?'))).toBe(false);
    expect(router.isExplicitlyAddressed(cfg({ status: 'silent', addressing_mode: 'always' }), said('привет'))).toBe(false);
  });

  it('команда владельца — обращение в любом статусе: /resume пишут как раз замолчанному', () => {
    expect(router.isExplicitlyAddressed(cfg({ status: 'silent' }), said('/resume'))).toBe(true);
    expect(router.isExplicitlyAddressed(cfg({ status: 'silent' }), said('/balance@LinkeonAgentBot'))).toBe(true);
  });
});

// ─── проводка через handleChatMessage ────────────────────────────────────────

describe('TgBotService.handleChatMessage: реплики бота — только когда он отвечает', () => {
  let root: string;
  let prevRoot: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-quiet-spec-'));
    prevRoot = process.env.TG_WORKSPACE_ROOT;
    process.env.TG_WORKSPACE_ROOT = root;
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.TG_WORKSPACE_ROOT;
    else process.env.TG_WORKSPACE_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Решения «отвечать ли» и «обратились ли» — настоящие, из TgRouterService:
   * проверяется поведение бота, а не то, что заглушка вернула нужное.
   * Остальное — заглушки, как в tg-bot.products-tool.spec.ts.
   */
  function makeTurnBot(o: { balance?: number; transcript?: string; alreadyNotified?: boolean; busy?: boolean; meetingHandled?: boolean; ownerLanguage?: string } = {}) {
    const real = makeRouter();
    const pg = {
      // busy — в чате уже идёт другой ход: замок не берётся.
      tryAdvisoryLock: jest.fn(async () => (o.busy ? null : { release: jest.fn(async () => {}) })),
      query: jest.fn(async () => ({ rows: [] })),
    };
    const identity = {
      getLinkeonIdByTgUserId: jest.fn(async () => null),
      getIdentityByLinkeonId: jest.fn(async () => ({ tgUserId: 111 })),
    };
    const router = {
      shouldRespond: jest.fn((cfg: any, ctx: any) => real.shouldRespond(cfg, ctx)),
      isExplicitlyAddressed: jest.fn((cfg: any, ctx: any) => (real as any).isExplicitlyAddressed(cfg, ctx)),
      persistUserMessage: jest.fn(async () => {}),
      markAnswerExpected: jest.fn(async () => {}),
      onlySpeakerIs: jest.fn(async () => false),
      generateReply: jest.fn(async (..._a: any[]) => ({ text: 'ответ', costUsd: 0.01 })),
      persistAssistantReply: jest.fn(async () => {}),
      consolidateAfterReply: jest.fn(async () => {}),
      persistTurnFailure: jest.fn(async () => {}),
      ownerLanguage: jest.fn(async () => o.ownerLanguage ?? 'ru'),
    };
    const voice = { transcribe: jest.fn(async () => o.transcript ?? '') };
    const billing = {
      getBalance: jest.fn(async () => o.balance ?? 100000),
      recentlyNotifiedZeroBalance: jest.fn(async () => !!o.alreadyNotified),
      markZeroBalanceNotified: jest.fn(async () => {}),
      tokensForTurn: jest.fn(() => 36),
      deduct: jest.fn(async () => 99964),
      alertIfExpensiveTurn: jest.fn(async () => {}),
      clearZeroBalanceFlag: jest.fn(async () => {}),
      checkBalanceAlerts: jest.fn(async () => {}),
      notifyOwnerZeroBalance: jest.fn(async () => {}),
      clearOwnerZeroBalanceDm: jest.fn(async () => {}),
    };
    const commands = { tryHandle: jest.fn(async () => false) };
    // meetingHandled — ссылка оказалась встречей, и сервис показал приглашение.
    const meetings = { tryHandleLink: jest.fn(async () => !!o.meetingHandled) };
    const grammy = {
      getBotUserId: jest.fn(async () => 999),
      sendChatAction: jest.fn(async () => {}),
      sendMessage: jest.fn(async (..._a: any[]) => ({ message_id: 55 })),
      editMessageText: jest.fn(async () => {}),
      deleteMessage: jest.fn(async () => {}),
    };
    const svc = new TgBotService(
      pg as any, identity as any, null as any, null as any, router as any,
      voice as any, billing as any, commands as any, meetings as any, grammy as any,
      null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    const sent = () => grammy.sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    return { svc, pg, router, billing, grammy, meetings, voice, sent };
  }

  // Оповещения владельца о балансе уходят в фоне: ход их не ждёт.
  const flush = () => new Promise((r) => setImmediate(r));

  const CFG: any = {
    id: 'cfg-quiet', owner_user_id: 'u-owner', tg_chat_id: '-100123', display_name: 'Финансист',
    voice_reply_mode: 'never', addressing_mode: 'strict', status: 'active', last_reply_at: null,
  };
  const groupMsg = (o: { text?: string; voice?: boolean; replyToBot?: boolean }) => ({
    chat: { id: -100123, type: 'supergroup' },
    from: { id: 222, first_name: 'Коллега' },
    message_id: 10,
    ...(o.voice ? { voice: { file_id: 'VOICE-1', duration: 3 } } : { text: o.text }),
    ...(o.replyToBot ? { reply_to_message: { message_id: 9, from: { id: 999 } } } : {}),
  });
  const echoes = (sent: string[]) => sent.filter((t) => t.startsWith('\u{1F399}'));
  const zeroNotices = (sent: string[]) => sent.filter((t) => t.includes('закончились токены'));
  const busyNotices = (sent: string[]) => sent.filter((t) => t.includes('Минутку'));
  const THINKING = '🤔 Думаю...';

  it('голосовое в режиме «по обращению» без обращения — ни эха, ни ответа', async () => {
    const { svc, router, sent } = makeTurnBot({ transcript: 'встречаемся в восемь у входа' });
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    expect(echoes(sent())).toEqual([]);
    expect(router.generateReply).not.toHaveBeenCalled();
    // Расшифровка всё равно ложится в историю: контекст группы бот видит.
    expect(router.persistUserMessage).toHaveBeenCalled();
  });

  it('голосовое с обращением — эхо расшифровки и ответ (контроль)', async () => {
    const { svc, router, grammy, sent } = makeTurnBot({ transcript: 'Финансист, сколько у нас осталось?' });
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    expect(echoes(sent())).toHaveLength(1);
    // Формат целиком: эмодзи с вариационным селектором, курсив, HTML.
    expect(grammy.sendMessage).toHaveBeenCalledWith(
      -100123,
      '\u{1F399}\u{FE0F} <i>«Финансист, сколько у нас осталось?»</i>',
      { reply_to_message_id: 10, parse_mode: 'HTML' },
    );
    expect(router.generateReply).toHaveBeenCalledTimes(1);
  });

  it('эхо не ломается на _ * [ ` и угловых скобках: HTML с экранированием', async () => {
    // В legacy-Markdown любой из этих знаков ронял сообщение («can't parse
    // entities»), а .catch молча глотал — эха просто не было.
    const { svc, grammy } = makeTurnBot({ transcript: 'Финансист, итог_2 *важно* [см] `код` 5 < 7 & 8 > 3' });
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    expect(grammy.sendMessage).toHaveBeenCalledWith(
      -100123,
      '\u{1F399}\u{FE0F} <i>«Финансист, итог_2 *важно* [см] `код` 5 &lt; 7 &amp; 8 &gt; 3»</i>',
      { reply_to_message_id: 10, parse_mode: 'HTML' },
    );
  });

  it('эхо доходит раньше «Думаю…»: сначала что бот услышал, потом что он думает', async () => {
    const { svc, grammy, sent } = makeTurnBot({ transcript: 'Финансист, сколько у нас осталось?' });
    let deliverEcho!: () => void;
    grammy.sendMessage.mockImplementation(async (_chat: number, text: string) => {
      if (String(text).startsWith('\u{1F399}')) await new Promise<void>((r) => { deliverEcho = r; });
      return { message_id: 55 };
    });

    const turn = (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    for (let i = 0; i < 20 && !deliverEcho; i++) await new Promise((r) => setImmediate(r));
    expect(deliverEcho).toBeDefined();
    // Telegram ещё не подтвердил эхо — статус не уходит.
    expect(sent()).not.toContain(THINKING);

    deliverEcho();
    await turn;
    expect(sent().indexOf(THINKING)).toBeGreaterThan(sent().findIndex((t) => t.startsWith('\u{1F399}')));
  });

  it('чат занят другим ходом, голосовое с обращением — эха нет: бот сейчас не отвечает', async () => {
    const { svc, sent } = makeTurnBot({ busy: true, transcript: 'Финансист, сколько у нас осталось?' });
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    expect(echoes(sent())).toEqual([]);
  });

  it('чат занят, обычная реплика группы — ни «Минутку», ни отметки «ждём ответа»', async () => {
    // Отметка без ответа бота позже — ложная тревога «бот молчит» в мониторинге.
    const { svc, router, sent } = makeTurnBot({ busy: true });
    await (svc as any).handleChatMessage(groupMsg({ text: 'встречаемся в восемь' }), CFG);
    expect(busyNotices(sent())).toEqual([]);
    expect(router.markAnswerExpected).not.toHaveBeenCalled();
    // В историю реплика ложится: дыр в контексте группы нет.
    expect(router.persistUserMessage).toHaveBeenCalled();
  });

  it('чат занят, к боту обратились — «Минутку» и отметка, как раньше', async () => {
    const { svc, router, sent } = makeTurnBot({ busy: true });
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, а дальше?' }), CFG);
    expect(busyNotices(sent())).toHaveLength(1);
    expect(router.markAnswerExpected).toHaveBeenCalled();
  });

  it('чат занят, замолчанный /silent бот — молчит и на обращение', async () => {
    const { svc, router, sent } = makeTurnBot({ busy: true });
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, ты тут?' }), { ...CFG, status: 'silent' });
    expect(busyNotices(sent())).toEqual([]);
    expect(router.markAnswerExpected).not.toHaveBeenCalled();
  });

  // Whisper с language не подсказывает, а ЗАСТАВЛЯЕТ: на чужой речи он
  // переводит или транслитерирует. Раньше всегда стоял 'ru' — немецкое
  // голосовое становилось кривой русской транслитерацией. Язык профиля — это
  // язык интерфейса и ответов, а не речи (браузер с uk/kk/be даёт профилю en),
  // поэтому заставляем только русский, а остальным Whisper определяет язык сам.
  it('владелец не на русском — язык голосового Whisper определяет сам', async () => {
    const { svc, voice } = makeTurnBot({ transcript: 'Finanzberater, wie viel?', ownerLanguage: 'de' });
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    expect(voice.transcribe).toHaveBeenCalledWith('VOICE-1', undefined);
  });

  it('владелец на русском — как раньше, русский', async () => {
    const { svc, voice } = makeTurnBot({ transcript: 'Финансист, сколько?', ownerLanguage: 'ru' });
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    expect(voice.transcribe).toHaveBeenCalledWith('VOICE-1', 'ru');
  });

  it('замолчанный /silent бот на голосовое с обращением — ни эха, ни ответа', async () => {
    const { svc, router, sent } = makeTurnBot({ transcript: 'Финансист, ты тут?' });
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), { ...CFG, status: 'silent' });
    expect(echoes(sent())).toEqual([]);
    expect(router.generateReply).not.toHaveBeenCalled();
  });

  // ─── приглашение на встречу ───────────────────────────────────────────────
  // Решение владельца 14.10.2026: на ссылку Linkeon/Zoom/Meet бот предлагает
  // зайти во встречу, только если к нему обратились; замолчанный — никогда.
  // Раньше карточка «зайдёт во встречу» уходила на любую ссылку в группе.
  const ZOOM = 'https://zoom.us/j/123456789';

  it('ссылка на встречу в обычной реплике группы — приглашения нет', async () => {
    const { svc, router, meetings } = makeTurnBot({ meetingHandled: true });
    await (svc as any).handleChatMessage(groupMsg({ text: `созвон тут ${ZOOM}` }), CFG);
    expect(meetings.tryHandleLink).not.toHaveBeenCalled();
    // Ход идёт обычным путём: реплика в истории, ответа нет (не обращались).
    expect(router.persistUserMessage).toHaveBeenCalled();
    expect(router.generateReply).not.toHaveBeenCalled();
  });

  it('ссылка на встречу с обращением к боту — приглашение', async () => {
    const { svc, router, meetings } = makeTurnBot({ meetingHandled: true });
    await (svc as any).handleChatMessage(groupMsg({ text: `Финансист, зайди ${ZOOM}` }), CFG);
    expect(meetings.tryHandleLink).toHaveBeenCalledWith(-100123, `Финансист, зайди ${ZOOM}`, 'u-owner');
    // Приглашение замыкает ход: в модель не идём.
    expect(router.generateReply).not.toHaveBeenCalled();
  });

  it('замолчанный /silent бот — не приглашает и на обращение', async () => {
    const { svc, meetings } = makeTurnBot({ meetingHandled: true });
    await (svc as any).handleChatMessage(groupMsg({ text: `Финансист, зайди ${ZOOM}` }), { ...CFG, status: 'silent' });
    expect(meetings.tryHandleLink).not.toHaveBeenCalled();
  });

  it('замолчанный бот: команда со ссылкой — не приглашение', async () => {
    // Команда — обращение к боту в любом статусе, но /silent значит «молчи»:
    // «/resume <ссылка>» не должен превращаться в карточку встречи.
    const { svc, meetings } = makeTurnBot({ meetingHandled: true });
    await (svc as any).handleChatMessage(groupMsg({ text: `/resume ${ZOOM}` }), { ...CFG, status: 'silent' });
    expect(meetings.tryHandleLink).not.toHaveBeenCalled();
  });

  it('команда со ссылкой исполняется как команда, а не приглашение', async () => {
    const { svc, meetings } = makeTurnBot({ meetingHandled: true });
    await (svc as any).handleChatMessage(groupMsg({ text: `/balance ${ZOOM}` }), CFG);
    expect(meetings.tryHandleLink).not.toHaveBeenCalled();
  });

  it('«умно» без обращения — приглашения нет (контроль): решает обращение, а не гейт', async () => {
    const { svc, meetings } = makeTurnBot({ meetingHandled: true });
    // Гейт «умного» режима здесь не дойдёт до модели: замок есть, но smartGate
    // упирается в resolveSystemPrompt без базы и отвечает «нет».
    await (svc as any).handleChatMessage(groupMsg({ text: `созвон тут ${ZOOM}` }), { ...CFG, addressing_mode: 'smart' });
    expect(meetings.tryHandleLink).not.toHaveBeenCalled();
  });

  it('«на каждое сообщение» — приглашает на любую ссылку (контроль)', async () => {
    const { svc, meetings } = makeTurnBot({ meetingHandled: true });
    await (svc as any).handleChatMessage(groupMsg({ text: `созвон тут ${ZOOM}` }), { ...CFG, addressing_mode: 'always' });
    expect(meetings.tryHandleLink).toHaveBeenCalledTimes(1);
  });

  it('успешный ход: отметки о нуле снимаются ПОСЛЕ записи ответа — и их сбой ход не роняет', async () => {
    const { svc, router, billing } = makeTurnBot({ transcript: '' });
    billing.clearOwnerZeroBalanceDm.mockRejectedValue(new Error('Connection is closed'));
    billing.clearZeroBalanceFlag.mockRejectedValue(new Error('canceling statement due to lock timeout'));
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, привет' }), CFG);
    await flush();
    expect(router.persistAssistantReply).toHaveBeenCalled();
    expect(router.consolidateAfterReply).toHaveBeenCalled();
    const persisted = router.persistAssistantReply.mock.invocationCallOrder[0];
    expect(billing.clearOwnerZeroBalanceDm.mock.invocationCallOrder[0]).toBeGreaterThan(persisted);
    expect(billing.clearZeroBalanceFlag.mock.invocationCallOrder[0]).toBeGreaterThan(persisted);
  });

  // ioredis при обрыве не падает сразу, а держит команду в очереди 23–63 с.
  // Ход не должен её ждать: он держит замок чата, и следующая реплика
  // человека в это время получает «Минутку» без ответа.
  it('Redis завис — ход не ждёт его и отпускает замок чата', async () => {
    const { svc, pg, router, billing } = makeTurnBot({ transcript: '' });
    const hang = () => new Promise<never>(() => {});
    billing.clearOwnerZeroBalanceDm.mockImplementation(hang);
    billing.checkBalanceAlerts.mockImplementation(hang);
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, привет' }), CFG);
    const lock = await (pg.tryAdvisoryLock.mock.results[0] as any).value;
    expect(lock.release).toHaveBeenCalled();
    expect(router.persistAssistantReply).toHaveBeenCalled();
  }, 2000);

  it('нулевой баланс и Redis завис — позвавшему объясняем сразу, не дожидаясь оповещения владельца', async () => {
    const { svc, billing, sent } = makeTurnBot({ balance: 0 });
    billing.notifyOwnerZeroBalance.mockImplementation(() => new Promise<never>(() => {}));
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, сколько осталось?' }), CFG);
    expect(zeroNotices(sent())).toHaveLength(1);
    expect(zeroNotices(sent())[0]).toContain('не отвечает, пока');
  }, 2000);

  it('нулевой баланс: сбой оповещения владельца не мешает объяснить позвавшему', async () => {
    const { svc, billing, sent } = makeTurnBot({ balance: 0 });
    billing.notifyOwnerZeroBalance.mockRejectedValue(new Error('Connection is closed'));
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, сколько осталось?' }), CFG);
    expect(zeroNotices(sent())).toHaveLength(1);
  });

  it('эхо длинной расшифровки режется по символам и с «…», а не посреди эмодзи', async () => {
    const { svc, sent } = makeTurnBot({ transcript: 'Финансист ' + 'я'.repeat(1100) });
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    const echo = echoes(sent())[0];
    expect(echo).toContain('…»');
    const long = makeTurnBot({ transcript: 'Финансист ' + '\u{1F600}'.repeat(600) });
    await (long.svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    const echo2 = echoes(long.sent())[0];
    expect(echo2).not.toContain('…');
    expect(Array.from(echo2).filter((c) => c === '\u{1F600}')).toHaveLength(600);
  });

  it('нулевой баланс в группе — владелец узнаёт сам, личкой (даже если к боту не обращались)', async () => {
    const { svc, billing } = makeTurnBot({ balance: 0 });
    await (svc as any).handleChatMessage(groupMsg({ text: 'встречаемся в восемь' }), CFG);
    await flush();
    expect(billing.notifyOwnerZeroBalance).toHaveBeenCalledWith('u-owner', 111);
  });

  it('нулевой баланс в личке — отдельного сообщения владельцу нет: предупреждение и так здесь', async () => {
    const { svc, billing } = makeTurnBot({ balance: 0 });
    await (svc as any).handleChatMessage(
      { ...groupMsg({ text: 'привет' }), chat: { id: 42, type: 'private' } },
      { ...CFG, tg_chat_id: '42', addressing_mode: 'always' },
    );
    expect(billing.notifyOwnerZeroBalance).not.toHaveBeenCalled();
  });

  it('нулевой баланс, обычная реплика группы — бот молчит', async () => {
    const { svc, billing, sent } = makeTurnBot({ balance: 0 });
    await (svc as any).handleChatMessage(groupMsg({ text: 'встречаемся в восемь' }), CFG);
    expect(zeroNotices(sent())).toEqual([]);
    expect(billing.markZeroBalanceNotified).not.toHaveBeenCalled();
  });

  it('нулевой баланс, к боту обратились — объясняет, почему не отвечает', async () => {
    const { svc, router, billing, sent } = makeTurnBot({ balance: 0 });
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, сколько осталось?' }), CFG);
    expect(zeroNotices(sent())).toHaveLength(1);
    expect(billing.markZeroBalanceNotified).toHaveBeenCalledWith(CFG.id);
    expect(router.generateReply).not.toHaveBeenCalled();
  });

  it('нулевой баланс, ответ на сообщение бота — тоже обращение', async () => {
    const { svc, sent } = makeTurnBot({ balance: 0 });
    await (svc as any).handleChatMessage(groupMsg({ text: 'а дальше?', replyToBot: true }), CFG);
    expect(zeroNotices(sent())).toHaveLength(1);
  });

  it('нулевой баланс, замолчанный /silent бот — молчит и на обращение', async () => {
    const { svc, sent } = makeTurnBot({ balance: 0 });
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, ты тут?' }), { ...CFG, status: 'silent' });
    expect(zeroNotices(sent())).toEqual([]);
  });

  it('нулевой баланс, замолчанному боту пришла команда — объясняет, как и раньше', async () => {
    // Команды при нулевом балансе не исполняются (проверка баланса стоит до
    // них) — так было и до этой правки. Но и молчать на /resume нельзя.
    const { svc, sent } = makeTurnBot({ balance: 0 });
    await (svc as any).handleChatMessage(groupMsg({ text: '/resume' }), { ...CFG, status: 'silent' });
    expect(zeroNotices(sent())).toHaveLength(1);
  });

  it('нулевой баланс, «на каждое сообщение» — объясняет на любую реплику (контроль)', async () => {
    const { svc, sent } = makeTurnBot({ balance: 0 });
    await (svc as any).handleChatMessage(groupMsg({ text: 'привет' }), { ...CFG, addressing_mode: 'always' });
    expect(zeroNotices(sent())).toHaveLength(1);
  });

  it('нулевой баланс, предупреждение было меньше 10 минут назад — не повторяется (контроль)', async () => {
    const { svc, sent } = makeTurnBot({ balance: 0, alreadyNotified: true });
    await (svc as any).handleChatMessage(groupMsg({ text: 'Финансист, ау' }), CFG);
    expect(zeroNotices(sent())).toEqual([]);
  });

  it('сторож роста стоимости: ход TG-бота — пара «бот + чат», списанное и кто платит', async () => {
    const { svc, billing } = makeTurnBot({ transcript: 'Финансист, сколько у нас осталось?' });
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    (svc as any).costGrowth = costGrowth;
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    await flush();
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [pair, turn, ctx] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(pair).toEqual({ kind: 'tg', configId: 'cfg-quiet', chatId: '-100123', payerUserId: 'u-owner', botName: 'Финансист' });
    // Ровно то, что списали у владельца, а не просто число из заглушки.
    expect(billing.deduct).toHaveBeenCalledTimes(1);
    expect(turn.tokens).toBe((billing.deduct.mock.calls[0] as any[])[1]);
    expect(turn.tokens).toBe(36);
    expect(turn.usd).toBeCloseTo(0.01, 4);
    expect(turn.note).toContain('cost=$');
    expect(await ctx.balance()).toBe(99964);
  });

  it('сторож роста стоимости: бот не отвечает — хода нет, списания нет, сторожа нет', async () => {
    const { svc, router, billing } = makeTurnBot({ transcript: 'встречаемся в восемь у входа' });
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    (svc as any).costGrowth = costGrowth;
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    await flush();
    expect(router.generateReply).not.toHaveBeenCalled();
    expect(billing.deduct).not.toHaveBeenCalled();
    expect(costGrowth.recordTurn).not.toHaveBeenCalled();
  });
});
