import { VoiceDocumentService } from './voice-document.service';
import { HOST_AGENT_ID } from './voice-call.types';

function makePg(jobRows: any[] = []) {
  const history: any[] = [];
  const charges: any[] = [];
  return {
    history,
    charges,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO custom_chat_history/i.test(sql)) {
        history.push({ session_id: params[0], agent: params[1], content: params[2], tokens: params[3] });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO token_consumption_tasks/i.test(sql)) {
        charges.push({ agent_id: params[2], output_tokens: params[3] });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM voice_call_jobs/i.test(sql)) {
        return { rows: jobRows, rowCount: jobRows.length };
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
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'текст документа', tokens: 1200, costUsd: 0.33 })) };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    const res = svc.create(CALL, ROOM, 'user-1', 'План запуска', 'по пунктам');

    expect(res).toMatchObject({ status: 'accepted', title: 'План запуска' });
    // Главное: тул уже вернулся, а модель ещё не звали — Realtime держит
    // разговор, пока тул не ответит.
    expect(chat.generateAgentReplyWithCharge).not.toHaveBeenCalled();
    await svc.drainForTests();
  });

  it('готовый документ попадает в чат с Романом, с заголовком', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'Первый пункт. Второй пункт.', tokens: 1200, costUsd: 0.33 })) };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    svc.create(CALL, ROOM, 'user-1', 'План запуска', 'по пунктам');
    await svc.drainForTests();

    expect(pg.history).toHaveLength(1);
    expect(pg.history[0]).toMatchObject({
      session_id: `user-1_${HOST_AGENT_ID}`,
      agent: HOST_AGENT_ID,
      content: '## План запуска\n\nПервый пункт. Второй пункт.',
    });
  });

  it('о начале и готовности сообщается в комнату', async () => {
    const lk = { send: jest.fn(async () => {}) };
    const svc = new VoiceDocumentService(makePg() as any, { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'текст', tokens: 1200, costUsd: 0.33 })) } as any, lk as any);

    svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await svc.drainForTests();

    const sent = lk.send.mock.calls.map((c: any[]) => c[1]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'document_pending', title: 'Письмо' }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'document_ready', title: 'Письмо' }));
  });

  it('документ без заголовка отклоняется, задача не заводится', () => {
    const chat = { generateAgentReplyWithCharge: jest.fn() };
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn() } as any);

    expect(svc.create(CALL, ROOM, 'user-1', '   ', 'что-то')).toEqual({ status: 'rejected', reason: 'no_title' });
    expect(chat.generateAgentReplyWithCharge).not.toHaveBeenCalled();
  });

  it('падение модели не роняет задачу — в комнату уходит document_failed', async () => {
    const pg = makePg();
    const lk = { send: jest.fn(async () => {}) };
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => { throw new Error('релей лёг'); }) };
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
    const svc = new VoiceDocumentService(pg as any, { generateAgentReplyWithCharge: jest.fn(async () => ({ text: '   ', tokens: 1200, costUsd: 0.33 })) } as any, lk as any);

    svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await svc.drainForTests();

    expect(pg.history).toHaveLength(0);
    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'document_failed' }),
    );
  });

  it('лимита одновременных документов нет — пятый тоже принимается', () => {
    // Снято по решению владельца 26.08.2026 вместе с лимитом на вопросы.
    const chat = { generateAgentReplyWithCharge: jest.fn(() => new Promise<never>(() => {})) }; // висят
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn(async () => {}) } as any);

    const results = ['раз', 'два', 'три', 'четыре', 'пять']
      .map((t) => svc.create(CALL, ROOM, 'u', t, ''));

    expect(results.every((r) => r.status === 'accepted')).toBe(true);
  });

  it('документ пишется в изолированной сессии — иначе релей отдаёт пустой поток', async () => {
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'текст', tokens: 1200, costUsd: 0.33 })) };
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn(async () => {}) } as any);

    svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await svc.drainForTests();

    const session = chat.generateAgentReplyWithCharge.mock.calls.map((c: any[]) => c[3])[0];
    expect(session).toMatch(/^voice_doc_/);
    expect(session).not.toBe(`user-1_${HOST_AGENT_ID}`);
  });
});

describe('кому принадлежит документ', () => {
  const CALL = '11111111-1111-1111-1111-111111111111';
  const ROOM = 'voice_room';

  it('документ Виталия ложится в чат с Виталием и списывается на него', async () => {
    // Владелец попросил Виталия подготовить бумагу, Роман согласился — а
    // документ уехал в чат Романа. Живой звонок 26.08.2026.
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 700, costUsd: 0.2 })) };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    const res = svc.create(CALL, ROOM, 'user-1', 'Тарифы', 'по пунктам', 'Виталий');
    await svc.drainForTests();

    expect(res).toMatchObject({ status: 'accepted', specialist: 'Виталий' });
    expect(pg.history[0].session_id).toBe('user-1_17');
    expect(pg.charges[0].agent_id).toBe(17);
    // И пишет его сам Виталий, а не ведущий.
    expect(chat.generateAgentReplyWithCharge.mock.calls.map((c: any[]) => c[1])[0]).toBe('17');
  });

  it('без имени пишет ведущий и кладёт себе', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 700, costUsd: 0.2 })) };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    const res = svc.create(CALL, ROOM, 'user-1', 'Заметка', '');
    await svc.drainForTests();

    expect(res).toMatchObject({ status: 'accepted' });
    expect((res as any).specialist).toBeUndefined();
    expect(pg.history[0].session_id).toBe(`user-1_${HOST_AGENT_ID}`);
  });

  it('незнакомое имя не роняет документ — пишет ведущий', async () => {
    const pg = makePg();
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 1, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
    );

    svc.create(CALL, ROOM, 'user-1', 'Заметка', '', 'Гэндальф');
    await svc.drainForTests();

    expect(pg.history[0].session_id).toBe(`user-1_${HOST_AGENT_ID}`);
  });

  it('в промпт документа попадают ПОЛНЫЕ ответы специалистов этого звонка', async () => {
    // Раньше документ писался по сжатой выжимке, которую слышал Роман, —
    // получалась бумага по пересказу консультации вместо самой консультации.
    const long = 'полный разбор Виталия '.repeat(50);
    const pg = makePg([{ specialist_agent_id: 17, question: 'как считать тарифы', answer: long }]);
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 700, costUsd: 0.2 })) };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    svc.create(CALL, ROOM, 'user-1', 'Тарифы', '', 'Виталий');
    await svc.drainForTests();

    const [prompt] = chat.generateAgentReplyWithCharge.mock.calls.map((c: any[]) => c[2]);
    expect(prompt).toContain('как считать тарифы');
    expect(prompt).toContain('полный разбор Виталия');
  });

  it('готовый документ уходит Роману с текстом — иначе он о нём не узнает', async () => {
    const lk = { send: jest.fn(async () => {}) };
    const svc = new VoiceDocumentService(
      makePg() as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'СОДЕРЖИМОЕ', tokens: 5, costUsd: 0 })) } as any,
      lk as any,
    );

    svc.create(CALL, ROOM, 'user-1', 'Тарифы', '', 'Виталий');
    await svc.drainForTests();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'document_ready', specialist: 'Виталий', text: 'СОДЕРЖИМОЕ' }),
    );
  });
});
