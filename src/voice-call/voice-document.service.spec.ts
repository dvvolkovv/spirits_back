import { VoiceDocumentService } from './voice-document.service';
import { HOST_AGENT_ID } from './voice-call.types';

function makePg() {
  const history: any[] = [];
  return {
    history,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO custom_chat_history/i.test(sql)) {
        history.push({ session_id: params[0], agent: params[1], content: params[2] });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

describe('VoiceDocumentService', () => {
  const CALL = '11111111-1111-1111-1111-111111111111';
  const ROOM = 'voice_room';

  it('create() возвращается мгновенно и НЕ зовёт модель синхронно', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => 'текст документа') };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    const res = svc.create(CALL, ROOM, 'user-1', 'План запуска', 'по пунктам');

    expect(res).toMatchObject({ status: 'accepted', title: 'План запуска' });
    // Главное: тул уже вернулся, а модель ещё не звали — Realtime держит
    // разговор, пока тул не ответит.
    expect(chat.generateAgentReply).not.toHaveBeenCalled();
    await svc.drainForTests();
  });

  it('готовый документ попадает в чат с Романом, с заголовком', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => 'Первый пункт. Второй пункт.') };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    svc.create(CALL, ROOM, 'user-1', 'План запуска', 'по пунктам');
    await svc.drainForTests();

    expect(pg.history).toEqual([
      {
        session_id: `user-1_${HOST_AGENT_ID}`,
        agent: HOST_AGENT_ID,
        content: '## План запуска\n\nПервый пункт. Второй пункт.',
      },
    ]);
  });

  it('о начале и готовности сообщается в комнату', async () => {
    const lk = { send: jest.fn(async () => {}) };
    const svc = new VoiceDocumentService(makePg() as any, { generateAgentReply: jest.fn(async () => 'текст') } as any, lk as any);

    svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await svc.drainForTests();

    const sent = lk.send.mock.calls.map((c: any[]) => c[1]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'document_pending', title: 'Письмо' }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'document_ready', title: 'Письмо' }));
  });

  it('документ без заголовка отклоняется, задача не заводится', () => {
    const chat = { generateAgentReply: jest.fn() };
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn() } as any);

    expect(svc.create(CALL, ROOM, 'user-1', '   ', 'что-то')).toEqual({ status: 'rejected', reason: 'no_title' });
    expect(chat.generateAgentReply).not.toHaveBeenCalled();
  });

  it('падение модели не роняет задачу — в комнату уходит document_failed', async () => {
    const pg = makePg();
    const lk = { send: jest.fn(async () => {}) };
    const chat = { generateAgentReply: jest.fn(async () => { throw new Error('релей лёг'); }) };
    const svc = new VoiceDocumentService(pg as any, chat as any, lk as any);

    svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await expect(svc.drainForTests()).resolves.toBeUndefined();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'document_failed', reason: 'error' }),
    );
    // Пустой документ в ленту не пишем.
    expect(pg.history).toHaveLength(0);
  });

  it('пустой ответ модели считается провалом, а не пустым документом', async () => {
    const pg = makePg();
    const lk = { send: jest.fn(async () => {}) };
    const svc = new VoiceDocumentService(pg as any, { generateAgentReply: jest.fn(async () => '   ') } as any, lk as any);

    svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await svc.drainForTests();

    expect(pg.history).toHaveLength(0);
    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'document_failed' }),
    );
  });

  it('четвёртый одновременный документ отклоняется', () => {
    const chat = { generateAgentReply: jest.fn(() => new Promise<string>(() => {})) }; // висит
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn(async () => {}) } as any);

    svc.create(CALL, ROOM, 'u', 'раз', '');
    svc.create(CALL, ROOM, 'u', 'два', '');
    svc.create(CALL, ROOM, 'u', 'три', '');

    expect(svc.create(CALL, ROOM, 'u', 'четыре', '')).toEqual({ status: 'rejected', reason: 'too_many_pending' });
  });

  it('документ пишется в изолированной сессии — иначе релей отдаёт пустой поток', async () => {
    const chat = { generateAgentReply: jest.fn(async () => 'текст') };
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn(async () => {}) } as any);

    svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await svc.drainForTests();

    const session = chat.generateAgentReply.mock.calls.map((c: any[]) => c[3])[0];
    expect(session).toMatch(/^voice_doc_/);
    expect(session).not.toBe(`user-1_${HOST_AGENT_ID}`);
  });
});
