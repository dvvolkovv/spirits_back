import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ChatController } from './chat.controller';
import { ChatModule } from './chat.module';
import { ContextResetModule } from './context-reset/context-reset.module';
import { ChatContextResetService } from './context-reset/context-reset.service';

/**
 * «Чистый лист» как точка отсчёта (spec 2026-11-17-context-reset): адрес
 * reset-context, черта в истории и совместимость старых клиентов, которые
 * по-прежнему шлют `fresh` + `freshTs` (вкладки до выката, Flutter, e2e).
 *
 * Изолированная fresh-сессия осталась только у пингов мониторинга — у
 * тестовых аккаунтов с `probe`; у всех остальных `fresh` — это точка, а ход
 * идёт в основную ленту.
 */

function makeCtrl(over: Partial<Record<string, any>> = {}) {
  const chatService = {
    streamChat: jest.fn(async () => {}),
    getChatHistory: jest.fn(async () => ({ messages: [], hasMore: false })),
    ...over.chatService,
  };
  const resets = {
    get: jest.fn(async () => null),
    reset: jest.fn(async (_u: string, _a: string, at?: Date) => at ?? new Date('2026-11-17T08:00:00Z')),
    ...over.resets,
  };
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: over.userId ?? 'u1' })) };
  const ctrl = new ChatController(chatService as any, jwtSvc as any, undefined as any, undefined);
  (ctrl as any).contextResets = resets;
  return { ctrl, chatService, resets };
}

const res = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
  setHeader: jest.fn(),
  write: jest.fn(),
  end: jest.fn(),
}) as any;

/** Запрос в той форме, которую читает chat(): userId — из Bearer через jwtSvc. */
const chatReq = (body: any) => ({ headers: { authorization: 'Bearer t' }, body }) as any;

/** userId телефонного аккаунта — это номер телефона; в журнал он попадать не должен. */
const PHONE = '79991234567';

describe('ChatController: «Чистый лист» как точка', () => {
  it('POST reset-context ставит точку и отдаёт её', async () => {
    const { ctrl, resets } = makeCtrl();
    const r = res();
    await ctrl.resetContext({ userId: 'u1' }, { assistantId: 10 }, r);
    expect(resets.reset).toHaveBeenCalledWith('u1', '10');
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ resetAt: '2026-11-17T08:00:00.000Z' });
  });

  it('reset-context без ассистента — 400', async () => {
    const { ctrl, resets } = makeCtrl();
    const r = res();
    await ctrl.resetContext({ userId: 'u1' }, {}, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(resets.reset).not.toHaveBeenCalled();
  });

  it('reset-context с ассистентом длиннее 100 символов — 400, точка не пишется', async () => {
    const { ctrl, resets } = makeCtrl();
    const r = res();
    await ctrl.resetContext({ userId: 'u1' }, { assistantId: 'x'.repeat(101) }, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(resets.reset).not.toHaveBeenCalled();
  });

  it('reset-context без сервиса точки — 503, а не молчаливый успех', async () => {
    const { ctrl } = makeCtrl();
    (ctrl as any).contextResets = undefined;
    const r = res();
    await ctrl.resetContext({ userId: 'u1' }, { assistantId: '10' }, r);
    expect(r.status).toHaveBeenCalledWith(503);
  });

  // Адрес ассистента — ровно в той форме, в какой его шлёт чат: число или
  // `custom:<uuid>` (AssistantSelection.tsx, ChatService.resolveAgent). Без
  // trim: chat() не тримит, и точка с пробелами легла бы не на ту пару.
  it.each([
    ['объект', { id: 10 }],
    ['массив', ['10']],
    ['пробел впереди', ' 10'],
    ['пробел сзади', '10 '],
    ['имя вместо id', 'Роман'],
    ['дробное число', 1.5],
    ['отрицательное', -10],
    ['custom: без uuid', 'custom:abc'],
    // resolveAgent сверяет префикс startsWith('custom:') с учётом регистра:
    // CUSTOM: — уже не пользовательский ассистент, точка легла бы не на ту пару.
    ['CUSTOM: заглавными', 'CUSTOM:3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b'],
    // uuid из Postgres строчный — так его и шлёт фронт; заглавный hex — не та пара.
    ['custom: с заглавным hex', 'custom:3F2B8C1E-9D4A-4E6B-8A7C-1B2D3E4F5A6B'],
  ])('reset-context: %s — 400, точка не пишется', async (_label, assistantId) => {
    const { ctrl, resets } = makeCtrl();
    const r = res();
    await ctrl.resetContext({ userId: 'u1' }, { assistantId }, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(resets.reset).not.toHaveBeenCalled();
  });

  it.each([
    ['число строкой', '10', '10'],
    ['число', 10, '10'],
    ['пользовательский ассистент', 'custom:3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b', 'custom:3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b'],
  ])('reset-context: %s — 200, точка на ту же пару', async (_label, assistantId, expected) => {
    const { ctrl, resets } = makeCtrl();
    const r = res();
    await ctrl.resetContext({ userId: 'u1' }, { assistantId }, r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(resets.reset).toHaveBeenCalledWith('u1', expected);
  });

  // Журнал — по правилу памяти загрузок (err-kind.ts): ни userId (у
  // телефонных аккаунтов это номер), ни ключа сессии, ни текста ошибки — только
  // id ассистента и вид ошибки.
  it('reset-context: сбой записи точки — 503 и строка в журнале: ассистент и вид ошибки, без номера и текста', async () => {
    const { ctrl } = makeCtrl({
      resets: { reset: jest.fn(async () => { throw Object.assign(new Error(`db down for ${PHONE}`), { code: 'ECONNREFUSED' }); }) },
    });
    const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
    const r = res();
    await ctrl.resetContext({ userId: PHONE }, { assistantId: '10' }, r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.json).toHaveBeenCalledWith({ error: 'context reset unavailable' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe('context reset failed (assistant "10"): Error code=ECONNREFUSED');
    expect(line).not.toContain(PHONE);
    expect(line).not.toContain('db down');
  });

  it('reset-context: удалённый аккаунт — 503, в журнале код отказа, а не текст', async () => {
    const { ctrl } = makeCtrl({
      resets: { reset: jest.fn(async () => { throw Object.assign(new Error('account deleted'), { code: 'ACCOUNT_DELETED' }); }) },
    });
    const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
    const r = res();
    await ctrl.resetContext({ userId: PHONE }, { assistantId: '10' }, r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(String(warn.mock.calls[0][0])).toBe('context reset failed (assistant "10"): Error code=ACCOUNT_DELETED');
  });

  it('история отдаёт contextResetAt и не читает freshTs', async () => {
    const at = new Date('2026-11-17T08:00:00Z');
    const { ctrl, chatService } = makeCtrl({ resets: { get: jest.fn(async () => at) } });
    const r = res();
    await ctrl.getHistory({ userId: 'u1' }, '10', '30', '0', r);
    expect(chatService.getChatHistory).toHaveBeenCalledWith('u1', '10', 30, 0);
    expect(r.json).toHaveBeenCalledWith({ messages: [], hasMore: false, contextResetAt: at.toISOString() });
  });

  it('сбой чтения точки — история отдаётся без черты', async () => {
    const { ctrl } = makeCtrl({ resets: { get: jest.fn(async () => { throw new Error('db down'); }) } });
    const r = res();
    await ctrl.getHistory({ userId: 'u1' }, '10', '30', '0', r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ messages: [], hasMore: false, contextResetAt: null });
  });

  it('обычный fresh старого клиента — точка на freshTs и ход в основную ленту', async () => {
    const ts = String(Date.now() - 60_000);
    const { ctrl, chatService, resets } = makeCtrl();
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', fresh: true, freshTs: ts }), res());
    expect(resets.reset).toHaveBeenCalledWith('u1', '10', new Date(Number(ts)));
    // Точка — до хода: ChatService прочитает её для ключа релея и хвоста.
    expect(resets.reset.mock.invocationCallOrder[0]).toBeLessThan(
      chatService.streamChat.mock.invocationCallOrder[0],
    );
    const args = chatService.streamChat.mock.calls[0] as any[];
    expect(args[3]).toBe('u1_10'); // sessionId
    expect(args[7]).toBe(false); // fresh
  });

  it('пинг мониторинга (probe у тестового аккаунта) — прежний изолированный путь, точка не трогается', async () => {
    const ts = String(Date.now());
    const { ctrl, chatService, resets } = makeCtrl({ userId: '70000000000' });
    await ctrl.chat(chatReq({ message: 'ping', assistantId: '12', fresh: true, freshTs: ts, probe: true }), res());
    expect(resets.reset).not.toHaveBeenCalled();
    const args = chatService.streamChat.mock.calls[0] as any[];
    expect(args[3]).toBe(`70000000000_12_fresh_${ts}`);
    expect(args[7]).toBe(true);
    expect(args[11]).toBe(true); // probe
  });

  it('probe у обычного аккаунта не признаётся: это старый клиент — точка и основная лента', async () => {
    const ts = String(Date.now() - 60_000);
    const { ctrl, chatService, resets } = makeCtrl();
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', fresh: true, freshTs: ts, probe: true }), res());
    expect(resets.reset).toHaveBeenCalledWith('u1', '10', new Date(Number(ts)));
    const args = chatService.streamChat.mock.calls[0] as any[];
    expect(args[3]).toBe('u1_10');
    expect(args[7]).toBe(false);
    expect(args[11]).toBe(false);
  });

  it('сбой записи точки не роняет ход — ассистент ответит с прежней памятью', async () => {
    const ts = String(Date.now() - 60_000);
    const { ctrl, chatService, resets } = makeCtrl({
      resets: { reset: jest.fn(async () => { throw new Error('db down'); }) },
    });
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', fresh: true, freshTs: ts }), res());
    expect(resets.reset).toHaveBeenCalled();
    expect(chatService.streamChat).toHaveBeenCalledTimes(1);
    const args = chatService.streamChat.mock.calls[0] as any[];
    expect(args[3]).toBe('u1_10');
    expect(args[7]).toBe(false);
  });

  it('сбой записи точки старого клиента — в журнале ассистент и вид ошибки, без номера, ключа сессии и текста', async () => {
    const ts = String(Date.now() - 60_000);
    const { ctrl } = makeCtrl({
      userId: PHONE,
      resets: { reset: jest.fn(async () => { throw Object.assign(new Error(`db down for ${PHONE}_10`), { code: '57P01' }); }) },
    });
    const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
    await ctrl.chat(chatReq({ message: 'секретный вопрос', assistantId: '10', fresh: true, freshTs: ts }), res());
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('legacy fresh reset failed (assistant "10"): Error code=57P01');
    const logged = lines.join('\n');
    expect(logged).not.toContain(PHONE);
    expect(logged).not.toContain('db down');
    expect(logged).not.toContain('секретный');
  });

  it('метка из будущего — точку не ставит', async () => {
    const { ctrl, chatService, resets } = makeCtrl();
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', fresh: true, freshTs: String(Date.now() + 3_600_000) }), res());
    expect(resets.reset).not.toHaveBeenCalled();
    const args = chatService.streamChat.mock.calls[0] as any[];
    expect(args[3]).toBe('u1_10');
    expect(args[7]).toBe(false);
  });

  /** Сдвиг метки от now в секундах из строки журнала (`\b` после кириллицы не работает). */
  const shiftSec = (line: string) => Number(/ ([+-]\d+) с$/.exec(line)?.[1]);

  it('отвергнутая метка — предупреждение в журнал: ассистент и сдвиг, без номера, ключа сессии и текста сообщения; два хода подряд — одно', async () => {
    const { ctrl, resets } = makeCtrl({ userId: PHONE });
    const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
    const future = String(Date.now() + 3_600_000);
    await ctrl.chat(chatReq({ message: 'секретный вопрос', assistantId: '10', fresh: true, freshTs: future }), res());
    await ctrl.chat(chatReq({ message: 'секретный вопрос', assistantId: '10', fresh: true, freshTs: future }), res());
    expect(resets.reset).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/^legacy fresh: метка отвергнута \(assistant "10"\), сдвиг [+-]\d+ с$/);
    expect(Math.abs(shiftSec(line) - 3600)).toBeLessThanOrEqual(2);
    expect(line).not.toContain(PHONE);
    expect(line).not.toContain('секретный');
  });

  it('метка в секундах (раньше 2024) — тоже предупреждение, сдвиг отрицательный', async () => {
    const { ctrl, resets } = makeCtrl();
    const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', fresh: true, freshTs: '1763000000' }), res());
    expect(resets.reset).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(shiftSec(String(warn.mock.calls[0][0]))).toBeLessThan(0);
  });

  it('прореживание — на пользователя и на час', async () => {
    const t0 = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const { ctrl } = makeCtrl();
      const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
      const as = (userId: string) => { (ctrl as any).jwtSvc.verify = jest.fn(() => ({ type: 'access', userId })); };
      // Метка на сутки вперёд — вне окна и через час.
      const body = { message: 'q', assistantId: '10', fresh: true, freshTs: String(t0 + 86_400_000) };

      as('u1'); await ctrl.chat(chatReq(body), res());
      as('u2'); await ctrl.chat(chatReq(body), res());
      as('u1'); await ctrl.chat(chatReq(body), res());
      expect(warn).toHaveBeenCalledTimes(2);

      now.mockReturnValue(t0 + 61 * 60_000);
      as('u1'); await ctrl.chat(chatReq(body), res());
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      now.mockRestore();
    }
  });

  it('без fresh — точку не трогает, sessionId из тела как раньше', async () => {
    const { ctrl, chatService, resets } = makeCtrl();
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', sessionId: 'u1_10_from_body' }), res());
    expect(resets.reset).not.toHaveBeenCalled();
    const args = chatService.streamChat.mock.calls[0] as any[];
    expect(args[3]).toBe('u1_10_from_body');
    expect(args[7]).toBe(false);
  });
});

/**
 * Точка у контроллера и ChatService — @Optional: забытое подключение модуля
 * старт не уронит, а молча оставит прод без «Чистого листа». Тип параметра —
 * класс, иначе Nest не найдёт провайдер (см. llm-provider-di.spec.ts).
 *
 * Здесь — только метаданные. Что в реальном графе AppModule ChatService и
 * ChatController получают один и тот же сервис точки, проверяет describe
 * `«Чистый лист»: один сервис точки у ChatService и ChatController` в
 * chat-uploads/chat-uploads.di.spec.ts (граф AppModule строится там один раз).
 */
describe('ChatController/ChatModule: подключение точки', () => {
  it('ChatController объявляет contextResets классом ChatContextResetService', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', ChatController);
    expect(paramTypes).toContain(ChatContextResetService);
  });

  it('ChatModule импортирует и реэкспортирует ContextResetModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatModule)).toContain(ContextResetModule);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ChatModule)).toContain(ContextResetModule);
  });
});
