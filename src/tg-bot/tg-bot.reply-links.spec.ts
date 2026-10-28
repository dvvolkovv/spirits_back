import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TgBotService } from './tg-bot.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TELEGRAM_TEXT_LIMIT } from './tg-text-split';
import { tgText } from './tg-i18n';

/**
 * Адреса в ответах бота (ревью трека 2, M6, 28.10.2026). С правилом ссылок
 * (chat/platform-guide.ts, linksRule('plain')) ассистент даёт в Telegram
 * полные адреса разделов кабинета. Без этих правок:
 *   • под ответом Telegram разворачивал превью страницы кабинета — карточку
 *     размером с сам ответ;
 *   • голосовой ответ зачитывал адрес по буквам.
 * Адрес при этом остаётся в тексте и в подписи к голосовому: там его видно и
 * можно нажать.
 */

const quiet = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };
const ZOOM = 'https://my.linkeon.io/profile?open=zoom';
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

const upgraded = () => Object.assign(new Error('Bad Request: group chat was upgraded to a supergroup chat'), {
  error_code: 400, parameters: { migrate_to_chat_id: -1004002 },
});

describe('ответ ассистента — без превью ссылок', () => {
  function makeBot() {
    const grammy = { sendMessage: jest.fn() };
    const configs = { moveToChat: jest.fn(async (..._a: any[]) => true) };
    const svc = new TgBotService(
      {} as any, {} as any, null as any, configs as any, null as any,
      null as any, null as any, null as any, null as any, grammy as any, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    return { svc, grammy };
  }

  it('обычная доставка: цитатой на вопрос и без превью', async () => {
    const { svc, grammy } = makeBot();
    grammy.sendMessage.mockResolvedValueOnce({ message_id: 5 });
    await svc.deliverReplyText(-100500, 42, `Карточка «Zoom»: ${ZOOM}`, 'ru');
    expect(grammy.sendMessage.mock.calls).toEqual([
      [-100500, `Карточка «Zoom»: ${ZOOM}`, { reply_to_message_id: 42, ...NO_PREVIEW }],
    ]);
  });

  it('после переезда группы в супергруппу — тоже без превью', async () => {
    const { svc, grammy } = makeBot();
    grammy.sendMessage.mockRejectedValueOnce(upgraded()).mockResolvedValueOnce({ message_id: 9 });
    await svc.deliverReplyText(-4002, 10, ZOOM, 'ru', { id: 'c', tg_chat_id: '-4002' } as any);
    expect(grammy.sendMessage).toHaveBeenLastCalledWith(-1004002, ZOOM, NO_PREVIEW);
  });

  it('длинный ответ: без превью каждый кусок, а не только первый', async () => {
    const api = { sendMessage: jest.fn(async (..._a: any[]) => ({ message_id: 1 })) };
    const client = new TgGrammyClient();
    (client as any).bot = { api };
    const svc = new TgBotService(
      {} as any, {} as any, null as any, {} as any, null as any,
      null as any, null as any, null as any, null as any, client, null as any, null as any, null as any,
    );
    (svc as any).logger = quiet;
    await svc.deliverReplyText(-100500, 42, `${'а'.repeat(TELEGRAM_TEXT_LIMIT)}\n${ZOOM}`, 'ru');
    const calls = api.sendMessage.mock.calls as any[];
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c[2].link_preview_options).toEqual({ is_disabled: true });
  });

  it('уведомление о сбое доставки — как было: ссылок в нём нет', async () => {
    const { svc, grammy } = makeBot();
    grammy.sendMessage.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ message_id: 6 });
    await expect(svc.deliverReplyText(-100500, 42, 'ответ', 'ru')).rejects.toThrow('boom');
    expect(grammy.sendMessage).toHaveBeenLastCalledWith(-100500, tgText('ru', 'delivery_failed'), { reply_to_message_id: 42 });
  });
});

/**
 * Правила для ссылок — те же, что у «Прослушать» в кабинете (spirits_front
 * src/components/chat/listen/speechText.ts): markdown-ссылка читается
 * надписью, голый адрес не читается вовсе.
 */
describe('TgBotService.speechText — голосом без адресов', () => {
  const say = TgBotService.speechText;

  it('голый адрес не читается, текст вокруг — на месте', () => {
    expect(say(`Zoom подключается в карточке: ${ZOOM} — там же отключается.`)).toBe(
      'Zoom подключается в карточке: — там же отключается.',
    );
  });

  it('адрес в скобках за названием — без пустых скобок, точка остаётся', () => {
    expect(say(`Откройте «Zoom» (${ZOOM}).`)).toBe('Откройте «Zoom».');
  });

  it('адрес отдельной строкой — строка уходит, остальные на месте', () => {
    expect(say(`Вот раздел:\n${ZOOM}\nТам кнопка «Подключить».`)).toBe('Вот раздел:\nТам кнопка «Подключить».');
  });

  it('markdown-ссылка читается надписью — и с полным адресом, и с путём', () => {
    expect(say(`Откройте [карточку Zoom](${ZOOM}) в настройках.`)).toBe('Откройте карточку Zoom в настройках.');
    expect(say('Раздел [Мой профиль](/profile) — там всё.')).toBe('Раздел Мой профиль — там всё.');
  });

  it('квадратные скобки без адреса — не ссылка: остаются как есть', () => {
    const t = 'Сноска [1](см. ниже) остаётся.';
    expect(say(t)).toBe(t);
  });

  it('http тоже, и не один адрес на строку', () => {
    expect(say('См. http://example.org/a и https://example.org/b?x=1, потом решим.')).toBe('См. и, потом решим.');
  });

  it('китайские знаки вплотную к адресу в адрес не входят', () => {
    expect(say(`请打开 ${ZOOM}。`)).toBe('请打开。');
  });

  it('текст без адресов не меняется', () => {
    const t = 'Привет! Чем помочь?\n\nДва абзаца — как были.';
    expect(say(t)).toBe(t);
  });

  it('ответ из одного адреса — читать нечего', () => {
    expect(say(`  ${ZOOM}  `)).toBe('');
  });
});

// Ход целиком в режиме «отвечать голосом»: что уходит в синтезатор, что — в подпись.
const turnDirs: string[] = [];
afterAll(() => {
  for (const d of turnDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeVoiceTurn(replyText: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reply-links-'));
  turnDirs.push(dir);
  const grammy = {
    getBotUserId: jest.fn(async () => 999),
    sendChatAction: jest.fn(async () => {}),
    sendMessage: jest.fn(async (..._a: any[]) => ({ message_id: 55 })),
    sendVoice: jest.fn(async (..._a: any[]) => ({ message_id: 56 })),
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
    generateReply: jest.fn(async (..._a: any[]) => ({ text: replyText, costUsd: 0.01 })),
    persistAssistantReply: jest.fn(async (..._a: any[]) => {}),
    consolidateAfterReply: jest.fn(async () => {}),
    persistTurnFailure: jest.fn(async () => {}),
    ownerLanguage: jest.fn(async () => 'ru'),
  };
  const voice = {
    transcribe: jest.fn(),
    synthesize: jest.fn(async (_text: string) => ({ buffer: Buffer.from('ogg'), costUsd: 0.0001 })),
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
  const svc = new TgBotService(
    pg as any, { getLinkeonIdByTgUserId: jest.fn(async () => null) } as any, null as any,
    { moveToChat: jest.fn(async () => true) } as any, router as any, voice as any, billing as any,
    { tryHandle: jest.fn(async () => false) } as any, { tryHandleLink: jest.fn(async () => false) } as any,
    grammy as any, null as any, null as any,
    { handleCaseCommand: jest.fn(async () => false), handleReplyEdit: jest.fn(async () => false) } as any,
    { recordTurn: jest.fn(async (..._a: any[]) => {}) } as any,
  );
  (svc as any).logger = quiet;
  jest.spyOn(svc as any, 'chatWorkspace').mockReturnValue(dir);
  jest.spyOn(svc as any, 'scanSandboxOutputs').mockReturnValue([]);
  jest.spyOn(svc as any, 'deliverOutgoingMarkers').mockResolvedValue(undefined);
  const cfg: any = {
    id: 'cfg-v', owner_user_id: 'u-owner', tg_chat_id: '-4002', display_name: 'Финансист',
    voice_reply_mode: 'always', addressing_mode: 'strict', status: 'active', last_reply_at: null,
  };
  const msg = { chat: { id: -4002, type: 'group' }, from: { id: 7 }, message_id: 1, text: 'Финансист, где подключить Zoom?' };
  return { svc, grammy, voice, cfg, msg };
}

describe('голосовой ответ — без адресов в озвучке', () => {
  it('синтезатор получает текст без адреса, а подпись к голосовому — с адресом', async () => {
    const reply = `Zoom подключается в «Настройках»: ${ZOOM} — там кнопка «Подключить».`;
    const { svc, grammy, voice, cfg, msg } = makeVoiceTurn(reply);
    await (svc as any).handleChatMessage(msg, cfg);
    expect(voice.synthesize).toHaveBeenCalledTimes(1);
    const spoken = String((voice.synthesize.mock.calls[0] as any[])[0]);
    expect(spoken).not.toMatch(/https?:\/\//);
    expect(spoken).toContain('Zoom подключается в «Настройках»');
    const [, , opts] = grammy.sendVoice.mock.calls[0] as any[];
    expect(opts.caption).toBe(reply);
  });

  it('ответ из одного адреса — текстом, без озвучки и без превью', async () => {
    const { svc, grammy, voice, cfg, msg } = makeVoiceTurn(ZOOM);
    await (svc as any).handleChatMessage(msg, cfg);
    expect(voice.synthesize).not.toHaveBeenCalled();
    expect(grammy.sendVoice).not.toHaveBeenCalled();
    expect(grammy.sendMessage).toHaveBeenCalledWith(-4002, ZOOM, { reply_to_message_id: 1, ...NO_PREVIEW });
  });
});
