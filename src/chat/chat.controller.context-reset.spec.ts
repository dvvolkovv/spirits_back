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

  it('метка из будущего — точку не ставит', async () => {
    const { ctrl, chatService, resets } = makeCtrl();
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', fresh: true, freshTs: String(Date.now() + 3_600_000) }), res());
    expect(resets.reset).not.toHaveBeenCalled();
    const args = chatService.streamChat.mock.calls[0] as any[];
    expect(args[3]).toBe('u1_10');
    expect(args[7]).toBe(false);
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
