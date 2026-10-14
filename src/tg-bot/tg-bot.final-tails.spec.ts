import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TgRouterService } from './tg-router.service';
import { TgBotService } from './tg-bot.service';
import { TgMeetingService } from './tg-meeting.service';
import { TgConfigService } from './tg-config.service';
import { TG_TEXTS, tgText } from './tg-i18n';
import { LanguageService } from '../common/services/language.service';

/**
 * Последние хвосты TG-бота (14.10.2026, «давай»):
 *   - /language менял служебные тексты и веб, но не язык ассистента в
 *     Telegram: в ход не шла языковая директива, которую получает веб;
 *   - ответ, пришедшийся на переезд группы в супергруппу, терялся;
 *   - «… на встрече» уходило в группу на языке нажавшего, а не владельца бота;
 *   - во французском перед « : ; ! ? » и внутри « » стояли обычные пробелы —
 *     в Telegram знак уезжал на новую строку;
 *   - в немецком у бота «Meeting», а в кабинете «Besprechung».
 */

const quiet = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };

// ─── Язык ответа ассистента ──────────────────────────────────────────────────

function makeRouter(language: string | null | Error) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/profile_data->>'language'/.test(sql)) {
        if (language instanceof Error) throw language;
        return { rows: language ? [{ language }] : [] };
      }
      return { rows: [] };
    }),
  };
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'ответ', costUsd: 0.01 })),
  };
  const svc = new TgRouterService(pg as any, null as any, null as any, null as any, claudeCli as any);
  (svc as any).logger = quiet;
  jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ name: 'Роман', systemPrompt: 'Ты Роман.' });
  jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'привет' }]);
  return { svc, claudeCli, pg };
}
const systemFrom = (c: any) => String(c.textWithCost.mock.calls[0][1].system || '');
const preset: any = { id: 1, tg_chat_id: '-100123', owner_user_id: 'u-1', preset_agent_id: '12' };
const custom: any = { id: 2, tg_chat_id: '-100123', owner_user_id: 'u-1', custom_agent_id: 'c-1' };

describe('язык ответа ассистента в Telegram — как в вебе', () => {
  it('промпт заканчивается языковой директивой владельца: последняя строка — на его языке', async () => {
    const { svc, claudeCli } = makeRouter('en');
    await svc.generateReply(preset, 'Dmitry');
    expect(systemFrom(claudeCli).trimEnd().endsWith(LanguageService.buildDirective('en').trimEnd())).toBe(true);
  });

  it('у бота с ассистентом пользователя — тоже: язык нужен всем, бренд тут ни при чём', async () => {
    const { svc, claudeCli } = makeRouter('de');
    await svc.generateReply(custom, 'Dmitry');
    expect(systemFrom(claudeCli)).toContain(LanguageService.buildDirective('de').trim());
  });

  it('язык не прочитался — директива по умолчанию, ход не падает', async () => {
    const { svc, claudeCli } = makeRouter(new Error('db down'));
    await svc.generateReply(preset, 'Дмитрий');
    expect(systemFrom(claudeCli)).toContain(LanguageService.buildDirective('ru').trim());
  });

  it('язык профиля читается один раз на ход — и для директивы, и для блока «Linkeon»', async () => {
    const { svc, pg } = makeRouter('fr');
    await svc.generateReply(preset, 'Dmitry');
    const reads = pg.query.mock.calls.filter((c: any[]) => /profile_data->>'language'/.test(String(c[0]))).length;
    expect(reads).toBe(1);
  });
});

// ─── Переезд посреди ответа ──────────────────────────────────────────────────

const upgraded = () => Object.assign(new Error('Bad Request: group chat was upgraded to a supergroup chat'), {
  error_code: 400, parameters: { migrate_to_chat_id: -1004001 },
});

// Ход целиком: за ответом идут картинки и файлы. Рабочие папки — во временном
// каталоге, после файла убираем.
const turnDirs: string[] = [];
afterAll(() => {
  for (const d of turnDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeTurn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-final-tails-'));
  turnDirs.push(dir);
  const file = path.join(dir, 'report.pdf');
  fs.writeFileSync(file, 'pdf');
  const grammy = {
    getBotUserId: jest.fn(async () => 999),
    sendChatAction: jest.fn(async () => {}),
    sendMessage: jest.fn(async (chatId: number, text: string, _o?: any) => {
      if (chatId === -4001 && text === 'ответ') throw upgraded();
      return { message_id: 55 };
    }),
    editMessageText: jest.fn(async () => {}),
    deleteMessage: jest.fn(async () => {}),
    sendDocument: jest.fn(async (..._a: any[]) => ({})),
  };
  const pg = {
    query: jest.fn(async () => ({ rows: [] })),
    tryAdvisoryLock: jest.fn(async () => ({ release: jest.fn(async () => {}) })),
  };
  const router = {
    shouldRespond: jest.fn(async () => true),
    isExplicitlyAddressed: jest.fn(() => true),
    persistUserMessage: jest.fn(async (..._a: any[]) => {}),
    markAnswerExpected: jest.fn(async () => {}),
    onlySpeakerIs: jest.fn(async () => false),
    generateReply: jest.fn(async (..._a: any[]) => ({ text: 'ответ', costUsd: 0.01 })),
    persistAssistantReply: jest.fn(async (..._a: any[]) => {}),
    consolidateAfterReply: jest.fn(async () => {}),
    persistTurnFailure: jest.fn(async () => {}),
    ownerLanguage: jest.fn(async () => 'ru'),
  };
  const billing = {
    getBalance: jest.fn(async () => 100000),
    tokensForTurn: jest.fn(() => 36),
    deduct: jest.fn(async () => 99964),
    alertIfExpensiveTurn: jest.fn(async () => {}),
    clearZeroBalanceFlag: jest.fn(async () => {}),
    checkBalanceAlerts: jest.fn(async () => {}),
    clearOwnerZeroBalanceDm: jest.fn(async () => {}),
  };
  const configs = { moveToChat: jest.fn(async (..._a: any[]) => true) };
  const costGrowth = { recordTurn: jest.fn(async (..._a: any[]) => {}) };
  const svc = new TgBotService(
    pg as any, { getLinkeonIdByTgUserId: jest.fn(async () => null) } as any, null as any, configs as any,
    router as any, { transcribe: jest.fn() } as any, billing as any, { tryHandle: jest.fn(async () => false) } as any,
    { tryHandleLink: jest.fn(async () => false) } as any, grammy as any, null as any, null as any,
    { handleCaseCommand: jest.fn(async () => false), handleReplyEdit: jest.fn(async () => false) } as any,
    costGrowth as any,
  );
  (svc as any).logger = quiet;
  jest.spyOn(svc as any, 'chatWorkspace').mockReturnValue(dir);
  jest.spyOn(svc as any, 'scanSandboxOutputs').mockReturnValue([file]);
  const markers = jest.spyOn(svc as any, 'deliverOutgoingMarkers').mockResolvedValue(undefined);
  const cfg: any = {
    id: 'cfg-g', owner_user_id: 'u-owner', tg_chat_id: '-4001', display_name: 'Финансист',
    voice_reply_mode: 'never', addressing_mode: 'strict', status: 'active', last_reply_at: null,
  };
  const msg = { chat: { id: -4001, type: 'group' }, from: { id: 7 }, message_id: 1, text: 'Финансист, привет' };
  return { svc, grammy, router, configs, costGrowth, markers, cfg, msg };
}

describe('ответ пришёлся на переезд группы в супергруппу', () => {
  function makeBot() {
    const grammy = { sendMessage: jest.fn() };
    const configs = { moveToChat: jest.fn(async (..._a: any[]) => true) };
    const svc = new TgBotService(
      {} as any, {} as any, null as any, configs as any, null as any,
      null as any, null as any, null as any, null as any, grammy as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    return { svc, grammy, configs };
  }

  it('бот переезжает и повторяет ответ в новый чат — без ответа на сообщение старой группы', async () => {
    const { svc, grammy, configs } = makeBot();
    grammy.sendMessage.mockRejectedValueOnce(upgraded()).mockResolvedValueOnce({ message_id: 9 });
    const cfg: any = { id: 'c', tg_chat_id: '-4001' };
    // Возвращает, куда ушёл ответ: туда же пойдут картинки и файлы хода.
    await expect(svc.deliverReplyText(-4001, 10, 'ответ', 'ru', cfg)).resolves.toBe(-1004001);
    expect(configs.moveToChat).toHaveBeenCalledWith(-4001, -1004001);
    expect(grammy.sendMessage).toHaveBeenLastCalledWith(-1004001, 'ответ', {});
    // История хода пишется дальше по cfg — уже в новый чат.
    expect(cfg.tg_chat_id).toBe('-1004001');
  });

  it('переезд не записался в базу — ответ всё равно в новом чате, а история остаётся там же, где конфиг', async () => {
    const { svc, grammy, configs } = makeBot();
    configs.moveToChat.mockResolvedValueOnce(false);
    grammy.sendMessage.mockRejectedValueOnce(upgraded()).mockResolvedValueOnce({ message_id: 9 });
    const cfg: any = { id: 'c', tg_chat_id: '-4001' };
    await expect(svc.deliverReplyText(-4001, 10, 'ответ', 'ru', cfg)).resolves.toBe(-1004001);
    expect(grammy.sendMessage).toHaveBeenLastCalledWith(-1004001, 'ответ', {});
    expect(cfg.tg_chat_id).toBe('-4001');
  });

  it('и в новом чате не прошло — текст в error-лог, уведомление уже в новый чат, исключение наверх', async () => {
    const { svc, grammy } = makeBot();
    const errors: string[] = [];
    (svc as any).logger = { ...quiet, error: (m: any) => { errors.push(String(m)); } };
    grammy.sendMessage
      .mockRejectedValueOnce(upgraded())
      .mockRejectedValueOnce(new Error('Forbidden: not enough rights to send text messages'))
      .mockResolvedValueOnce({ message_id: 1 });
    await expect(svc.deliverReplyText(-4001, 10, 'уникальный текст ответа', 'ru', { id: 'c', tg_chat_id: '-4001' } as any))
      .rejects.toThrow('not enough rights');
    // Это единственная копия ответа, за который уже заплачено.
    expect(errors.join('\n')).toContain('уникальный текст ответа');
    expect(grammy.sendMessage).toHaveBeenLastCalledWith(-1004001, tgText('ru', 'delivery_failed'), {});
  });

  it('другая ошибка — как раньше: уведомление о сбое и исключение наверх (контроль)', async () => {
    const { svc, grammy, configs } = makeBot();
    grammy.sendMessage.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ message_id: 1 });
    await expect(svc.deliverReplyText(-4001, 10, 'ответ', 'ru')).rejects.toThrow('boom');
    expect(configs.moveToChat).not.toHaveBeenCalled();
  });

  it('картинки и файлы этого хода — в новый чат, без ответа на сообщение старой группы', async () => {
    const { svc, grammy, configs, costGrowth, markers, cfg, msg } = makeTurn();
    await (svc as any).handleChatMessage(msg, cfg);
    expect(configs.moveToChat).toHaveBeenCalledWith(-4001, -1004001);
    const [outMsg] = (markers.mock.calls[0] as any[]).slice(1);
    expect(outMsg.chat.id).toBe(-1004001);
    expect(outMsg.message_id).toBeUndefined();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
    const [chatId, , name, opts] = grammy.sendDocument.mock.calls[0] as any[];
    expect([chatId, name, opts?.reply_to_message_id]).toEqual([-1004001, 'report.pdf', undefined]);
    // История и сторож роста стоимости — уже по новому чату.
    expect(cfg.tg_chat_id).toBe('-1004001');
    expect((costGrowth.recordTurn.mock.calls[0] as any[])[0].chatId).toBe('-1004001');
  });

  it('переезд не записался в базу — файлы всё равно идут туда, куда ушёл ответ', async () => {
    const t = makeTurn();
    t.configs.moveToChat.mockResolvedValueOnce(false);
    await (t.svc as any).handleChatMessage(t.msg, t.cfg);
    expect((t.grammy.sendDocument.mock.calls[0] as any[])[0]).toBe(-1004001);
    expect(t.cfg.tg_chat_id).toBe('-4001');
  });

  it('без переезда — файлы, как раньше, ответом на сообщение в этом же чате (контроль)', async () => {
    const t = makeTurn();
    t.grammy.sendMessage.mockImplementation(async () => ({ message_id: 55 }));
    await (t.svc as any).handleChatMessage(t.msg, t.cfg);
    expect(t.configs.moveToChat).not.toHaveBeenCalled();
    expect((t.markers.mock.calls[0] as any[])[1]).toBe(t.msg);
    const [chatId, , , opts] = t.grammy.sendDocument.mock.calls[0] as any[];
    expect([chatId, opts?.reply_to_message_id]).toEqual([-4001, 1]);
    expect((t.costGrowth.recordTurn.mock.calls[0] as any[])[0].chatId).toBe('-4001');
  });
});

describe('moveToChat говорит, где теперь работающий конфиг', () => {
  const make = (rows: any[] | Error) => {
    const pg = { query: jest.fn(async () => { if (rows instanceof Error) throw rows; return { rows }; }) };
    const svc = new TgConfigService(pg as any, {} as any);
    (svc as any).logger = quiet;
    return Object.assign(svc, { pg });
  };

  it('конфиг на новом id — переехал сейчас или раньше — true', async () => {
    expect(await make([{ moved_id: 'cfg', settled: true }]).moveToChat(-4001, -1004001)).toBe(true);
    expect(await make([{ moved_id: null, settled: true }]).moveToChat(-4001, -1004001)).toBe(true);
  });

  it('переезжают одновременно (служебное сообщение и ход): ждавший блокировку не видит конфиг по своему снимку — повтор видит', async () => {
    const pg = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ moved_id: null, settled: false }] })
        .mockResolvedValueOnce({ rows: [{ moved_id: null, settled: true }] }),
    };
    const svc = new TgConfigService(pg as any, {} as any);
    (svc as any).logger = quiet;
    expect(await svc.moveToChat(-4001, -1004001)).toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(2);
  });

  it('переехал с первого раза — второй запрос не нужен (контроль)', async () => {
    const svc = make([{ moved_id: 'cfg', settled: true }]);
    expect(await svc.moveToChat(-4001, -1004001)).toBe(true);
    expect(svc.pg.query).toHaveBeenCalledTimes(1);
  });

  it('работающего конфига нет ни там, ни там, или запрос упал — false', async () => {
    expect(await make([{ moved_id: null, settled: false }]).moveToChat(-4001, -1004001)).toBe(false);
    expect(await make(new Error('db down')).moveToChat(-4001, -1004001)).toBe(false);
  });
});

// ─── Файл без подписи ────────────────────────────────────────────────────────

describe('файл без подписи: служебная пометка не задаёт язык ответа', () => {
  // Директива языка велит отвечать на языке последнего сообщения человека, а
  // пометка о файле без подписи и есть последнее «сообщение» — по-русски.
  async function noteFor(files: string[]) {
    const t = makeTurn();
    t.grammy.sendMessage.mockImplementation(async () => ({ message_id: 55 }));
    jest.spyOn(t.svc as any, 'downloadIncomingAttachments').mockResolvedValue(files);
    const photo = { chat: { id: -4001, type: 'group' }, from: { id: 7 }, message_id: 2, photo: [{ file_id: 'f1' }] };
    await (t.svc as any).handleChatMessage(photo, t.cfg);
    return String((t.router.persistUserMessage.mock.calls[0] as any[])[1].text);
  }

  it('пометка названа служебной и отсылает к блоку языка — её русский не примут за язык собеседника', async () => {
    const note = await noteFor(['/tmp/photo.jpg']);
    expect(note).toMatch(/служебн/i);
    // Заголовок блока берём из самой директивы: переименуют — тест подскажет.
    expect(LanguageService.buildDirective('en')).toContain('ЯЗЫК ОБЩЕНИЯ');
    expect(note).toContain('ЯЗЫК ОБЩЕНИЯ');
  });

  it('несколько файлов — та же оговорка и просьба разобрать все', async () => {
    const note = await noteFor(['/tmp/a.jpg', '/tmp/b.pdf']);
    expect(note).toContain('ЯЗЫК ОБЩЕНИЯ');
    expect(note).toMatch(/2/);
    expect(note).toMatch(/ВСЕ/);
  });
});

// ─── «… на встрече» ──────────────────────────────────────────────────────────

describe('встреча: «… на встрече» — на языке владельца бота, подсказки — нажавшему на его', () => {
  const pgByUser = () => ({
    query: jest.fn(async (sql: string, p?: any[]) => {
      if (/profile_data->>'language'/.test(sql)) return { rows: [{ language: p?.[0] === 'u-owner' ? 'fr' : 'de' }] };
      if (/FROM ai_profiles_consolidated p/.test(sql)) return { rows: [{ id: 7, name: 'Roman' }] };
      return { rows: [] };
    }),
  });

  it('TgBotService передаёт встрече язык владельца бота этой группы', async () => {
    const meetings = { handleJoinCallback: jest.fn(async () => {}) };
    const configs = { getActiveByTgChatId: jest.fn(async () => ({ id: 'cfg', owner_user_id: 'u-owner' })) };
    const svc = new TgBotService(
      pgByUser() as any, { getLinkeonIdByTgUserId: jest.fn(async () => 'u-clicker') } as any, null as any, configs as any,
      null as any, null as any, null as any, null as any, meetings as any, {} as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    const cb = { id: 'cb', data: 'meet:linkeon:abc', from: { id: 5 }, message: { chat: { id: -100 } } };
    await (svc as any).handleCallbackQuery(cb);
    expect(meetings.handleJoinCallback).toHaveBeenCalledWith(cb, 'u-clicker', 'fr');
  });

  it('TgMeetingService: «… на встрече» уходит в группу на языке владельца бота', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})), answerCallbackQuery: jest.fn(async () => ({})) };
    const svc = new TgMeetingService(pgByUser() as any, grammy as any, { join: jest.fn(async () => {}) } as any, {} as any, {} as any, {} as any);
    (svc as any).logger = quiet;
    await svc.handleJoinCallback({ id: 'cb', data: 'meet:linkeon:abc', message: { chat: { id: -100 } } }, 'u-clicker', 'fr');
    expect((grammy.sendMessage.mock.calls[0] as any[])[1]).toBe(tgText('fr', 'meeting_joined', { agent: 'Roman' }));
  });

  it('без языка группы (личка) — всё на языке нажавшего, как раньше', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})), answerCallbackQuery: jest.fn(async () => ({})) };
    const svc = new TgMeetingService(pgByUser() as any, grammy as any, { join: jest.fn(async () => {}) } as any, {} as any, {} as any, {} as any);
    (svc as any).logger = quiet;
    await svc.handleJoinCallback({ id: 'cb', data: 'meet:linkeon:abc', message: { chat: { id: 42 } } }, 'u-clicker');
    expect((grammy.sendMessage.mock.calls[0] as any[])[1]).toBe(tgText('de', 'meeting_joined', { agent: 'Roman' }));
  });

  it('поиск конфига группы упал — во встречу всё равно пускаем, на языке нажавшего', async () => {
    const meetings = { handleJoinCallback: jest.fn(async () => {}) };
    const configs = { getActiveByTgChatId: jest.fn(async () => { throw new Error('db down'); }) };
    const svc = new TgBotService(
      pgByUser() as any, { getLinkeonIdByTgUserId: jest.fn(async () => 'u-clicker') } as any, null as any, configs as any,
      null as any, null as any, null as any, null as any, meetings as any, {} as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    const cb = { id: 'cb', data: 'meet:linkeon:abc', from: { id: 5 }, message: { chat: { id: -100 } } };
    await (svc as any).handleCallbackQuery(cb);
    expect(meetings.handleJoinCallback).toHaveBeenCalledWith(cb, 'u-clicker', undefined);
  });

  it('вход не удался — всплывающий ответ нажавшему на его языке, а не на языке группы', async () => {
    const grammy = { sendMessage: jest.fn(async () => ({})), answerCallbackQuery: jest.fn(async (..._a: any[]) => ({})) };
    const join = jest.fn(async () => { throw new Error('room closed'); });
    const svc = new TgMeetingService(pgByUser() as any, grammy as any, { join } as any, {} as any, {} as any, {} as any);
    (svc as any).logger = quiet;
    await svc.handleJoinCallback({ id: 'cb', data: 'meet:linkeon:abc', message: { chat: { id: -100 } } }, 'u-clicker', 'fr');
    expect((grammy.answerCallbackQuery.mock.calls[0] as any[])[1]).toEqual({ text: tgText('de', 'meeting_unavailable') });
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });
});

// ─── Типографика ─────────────────────────────────────────────────────────────

describe('французская типографика — неразрывные пробелы', () => {
  const fr = Object.entries(TG_TEXTS.fr);

  it('перед « : ; ! ? » и внутри « » нет обычного пробела — знак не уедет на новую строку', () => {
    const bad = fr.filter(([, v]) => / [:;!?»]/.test(v) || /« /.test(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('и сами пробелы на месте: «Solde de jetons : …» не слипается', () => {
    expect(tgText('fr', 'balance')).toMatch(/jetons[\u00a0\u202f]:/);
    expect(tgText('fr', 'list_group', { name: 'X', group: 'Y' })).toMatch(/«[\u00a0\u202f]Y[\u00a0\u202f]»/);
  });

  it('проверка видит обычный пробел, если он есть (сторож сторожа)', () => {
    expect(/ [:;!?»]/.test('Solde de jetons : 5')).toBe(true);
    expect(/ [:;!?»]/.test('Solde de jetons\u00a0: 5')).toBe(false);
  });

  it('и знак не прилип к слову вовсе без пробела («jetons: 5», «{group}»)', () => {
    // \s в JS включает и U+00A0, и U+202F — «не пробел» это просто \S.
    const GLUED = /\S[;!?»]|«\S|\S:(?!\/\/)/;
    expect(fr.filter(([, v]) => GLUED.test(v)).map(([k]) => k)).toEqual([]);
    expect(GLUED.test('Solde de jetons: 5')).toBe(true);
    expect(GLUED.test('«{group}»')).toBe(true);
    // Адрес — не знак препинания: «https://» не в счёт.
    expect(GLUED.test('Recharger\u00a0: https://my.linkeon.io/tokens')).toBe(false);
  });
});

describe('немецкий: «Besprechung», как в кабинете', () => {
  it('ни одно сообщение о встрече не говорит «Meeting»', () => {
    const bad = Object.entries(TG_TEXTS.de).filter(([k, v]) => k.startsWith('meeting_') && /Meeting/.test(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
