import { VoiceDocumentService } from './voice-document.service';
import { HOST_AGENT_ID } from './voice-call.types';

/** Сам документ среди строк чата: ai-строка с markdown-заголовком. */
const docRow = (history: any[]) => history.find((h) => h.sender_type === 'ai' && String(h.content).startsWith('##'));
/** Строки, которых быть не должно, если документ не получился. */
const docRows = (history: any[]) => history.filter((h) => String(h.content).startsWith('##'));

/**
 * «Сейчас» для проверок окна свежести. В бою его берёт Postgres из now(),
 * здесь — фейк, поэтому момент задан явно и от часов машины не зависит.
 */
const NOW = Date.UTC(2026, 7, 28, 10, 0, 0);

/** Консультация звонка, законченная столько-то минут назад. */
const jobDoneMinutesAgo = (agentId: number, minutes: number, extra: Record<string, unknown> = {}) => ({
  specialist_agent_id: agentId,
  finished_at: new Date(NOW - minutes * 60_000).toISOString(),
  ...extra,
});

function makeLang() {
  return { resolveUserLanguage: jest.fn(async () => 'ru') };
}

function makeStorage(fail = false) {
  const uploads: any[] = [];
  return {
    uploads,
    upload: jest.fn(async (i: any) => {
      if (fail) throw new Error('MinIO недоступен');
      uploads.push({ key: i.key, contentType: i.contentType, body: String(i.body) });
      return `https://my.linkeon.io/smm-media/${i.bucket}/${i.key}`;
    }),
  };
}

function makePg(jobRows: any[] = []) {
  const history: any[] = [];
  const charges: any[] = [];
  return {
    history,
    charges,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO custom_chat_history/i.test(sql)) {
        history.push({
          session_id: params[0],
          agent: params[1],
          content: params[2],
          tokens: params[3],
          sender_type: /'human'/.test(sql) ? 'human' : 'ai',
        });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO token_consumption_tasks/i.test(sql)) {
        charges.push({ agent_id: params[2], output_tokens: params[3] });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM voice_call_jobs/i.test(sql)) {
        // Догадка об авторе спрашивает только СВЕЖИЕ консультации, и фейк обязан
        // этот отбор повторять. Иначе тест на окно зеленел бы при любом коде:
        // фейк отдавал бы протухшую строку, сервис брал бы её автором, а тест
        // радовался бы. Проверено обратным ходом — с прежним запросом падает.
        if (/make_interval/i.test(sql)) {
          const windowMs = Number(params[1]) * 60_000;
          const fresh = jobRows.filter(
            (r) => r.finished_at != null && NOW - new Date(r.finished_at).getTime() < windowMs,
          );
          return { rows: fresh, rowCount: fresh.length };
        }
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
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeStorage() as any, makeLang() as any);

    const res = await svc.create(CALL, ROOM, 'user-1', 'План запуска', 'по пунктам');

    expect(res).toMatchObject({ status: 'accepted', title: 'План запуска' });
    // Главное: тул уже вернулся, а модель ещё не звали — Realtime держит
    // разговор, пока тул не ответит. Один запрос за автором тут есть, и это
    // осознанная цена: сочинение документа занимает десятки секунд, выбор
    // автора — миллисекунды.
    expect(chat.generateAgentReplyWithCharge).not.toHaveBeenCalled();
    await svc.drainForTests();
  });

  it('готовый документ попадает в чат с Романом, с заголовком', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'Первый пункт. Второй пункт.', tokens: 1200, costUsd: 0.33 })) };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeStorage() as any, makeLang() as any);

    await svc.create(CALL, ROOM, 'user-1', 'План запуска', 'по пунктам');
    await svc.drainForTests();

    // Первой строкой — задание (оно ложится сразу), второй — сам документ.
    expect(pg.history).toHaveLength(2);
    expect(pg.history[0].sender_type).toBe('human');
    const doc = docRow(pg.history);
    expect(doc.session_id).toBe(`user-1_${HOST_AGENT_ID}`);
    expect(doc.content).toContain('## План запуска');
    expect(doc.content).toContain('Первый пункт. Второй пункт.');
  });

  it('о начале и готовности сообщается в комнату', async () => {
    const lk = { send: jest.fn(async () => {}) };
    const svc = new VoiceDocumentService(makePg() as any, { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'текст', tokens: 1200, costUsd: 0.33 })) } as any, lk as any, makeStorage() as any, makeLang() as any);

    await svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await svc.drainForTests();

    const sent = lk.send.mock.calls.map((c: any[]) => c[1]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'document_pending', title: 'Письмо' }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'document_ready', title: 'Письмо' }));
  });

  it('документ без заголовка отклоняется, задача не заводится', () => {
    const chat = { generateAgentReplyWithCharge: jest.fn() };
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn() } as any, makeStorage() as any, makeLang() as any);

    await expect(svc.create(CALL, ROOM, 'user-1', '   ', 'что-то')).resolves.toEqual({ status: 'rejected', reason: 'no_title' });
    expect(chat.generateAgentReplyWithCharge).not.toHaveBeenCalled();
  });

  it('падение модели не роняет задачу — в комнату уходит document_failed', async () => {
    const pg = makePg();
    const lk = { send: jest.fn(async () => {}) };
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => { throw new Error('релей лёг'); }) };
    const svc = new VoiceDocumentService(pg as any, chat as any, lk as any, makeStorage() as any, makeLang() as any);

    await svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await expect(svc.drainForTests()).resolves.toBeUndefined();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'document_failed', reason: 'error' }),
    );
    // Документа нет, но задание и отметка о неудаче остались: иначе не
    // отличить «не получилось» от «ещё пишется».
    expect(docRows(pg.history)).toHaveLength(0);
    expect(pg.history.map((h: any) => h.sender_type)).toEqual(['human', 'ai']);
    expect(pg.history[1].content).toContain('не удалось');
  });

  it('пустой ответ модели считается провалом, а не пустым документом', async () => {
    const pg = makePg();
    const lk = { send: jest.fn(async () => {}) };
    const svc = new VoiceDocumentService(pg as any, { generateAgentReplyWithCharge: jest.fn(async () => ({ text: '   ', tokens: 1200, costUsd: 0.33 })) } as any, lk as any, makeStorage() as any, makeLang() as any);

    await svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
    await svc.drainForTests();

    expect(docRows(pg.history)).toHaveLength(0);
    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'document_failed' }),
    );
  });

  it('лимита одновременных документов нет — пятый тоже принимается', () => {
    // Снято по решению владельца 26.08.2026 вместе с лимитом на вопросы.
    const chat = { generateAgentReplyWithCharge: jest.fn(() => new Promise<never>(() => {})) }; // висят
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn(async () => {}) } as any, makeStorage() as any, makeLang() as any);

    const results = await Promise.all(
      ['раз', 'два', 'три', 'четыре', 'пять'].map((t) => svc.create(CALL, ROOM, 'u', t, '')),
    );

    expect(results.every((r) => r.status === 'accepted')).toBe(true);
  });

  it('документ пишется в изолированной сессии — иначе релей отдаёт пустой поток', async () => {
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'текст', tokens: 1200, costUsd: 0.33 })) };
    const svc = new VoiceDocumentService(makePg() as any, chat as any, { send: jest.fn(async () => {}) } as any, makeStorage() as any, makeLang() as any);

    await svc.create(CALL, ROOM, 'user-1', 'Письмо', '');
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
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeStorage() as any, makeLang() as any);

    const res = await svc.create(CALL, ROOM, 'user-1', 'Тарифы', 'по пунктам', 'Виталий');
    await svc.drainForTests();

    expect(res).toMatchObject({ status: 'accepted', specialist: 'Виталий' });
    expect(docRow(pg.history).session_id).toBe('user-1_17');
    expect(pg.charges[0].agent_id).toBe(17);
    // И пишет его сам Виталий, а не ведущий.
    expect(chat.generateAgentReplyWithCharge.mock.calls.map((c: any[]) => c[1])[0]).toBe('17');
  });

  it('без имени пишет ведущий и кладёт себе', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 700, costUsd: 0.2 })) };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeStorage() as any, makeLang() as any);

    const res = await svc.create(CALL, ROOM, 'user-1', 'Заметка', '');
    await svc.drainForTests();

    expect(res).toMatchObject({ status: 'accepted' });
    expect((res as any).specialist).toBeUndefined();
    expect(docRow(pg.history).session_id).toBe(`user-1_${HOST_AGENT_ID}`);
  });

  it('незнакомое имя не роняет документ — пишет ведущий', async () => {
    const pg = makePg();
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 1, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Заметка', '', 'Гэндальф');
    await svc.drainForTests();

    expect(docRow(pg.history).session_id).toBe(`user-1_${HOST_AGENT_ID}`);
  });

  it('в промпт документа попадают ПОЛНЫЕ ответы специалистов этого звонка', async () => {
    // Раньше документ писался по сжатой выжимке, которую слышал Роман, —
    // получалась бумага по пересказу консультации вместо самой консультации.
    const long = 'полный разбор Виталия '.repeat(50);
    const pg = makePg([{ specialist_agent_id: 17, question: 'как считать тарифы', answer: long }]);
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 700, costUsd: 0.2 })) };
    const svc = new VoiceDocumentService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeStorage() as any, makeLang() as any);

    await svc.create(CALL, ROOM, 'user-1', 'Тарифы', '', 'Виталий');
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
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Тарифы', '', 'Виталий');
    await svc.drainForTests();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'document_ready', specialist: 'Виталий', text: 'СОДЕРЖИМОЕ' }),
    );
  });
});

describe('документ доступен по ссылке', () => {
  const CALL = '11111111-1111-1111-1111-111111111111';
  const ROOM = 'voice_room';
  const LONG = 'Пункт про тарифы и ограничения минут. '.repeat(60); // ~2200 знаков

  it('текст выкладывается файлом, а в ленту идёт вступление со ссылкой', async () => {
    // Владелец 26.08.2026: документ на 6 315 знаков лёг в чат целиком —
    // стена текста вместо документа.
    const pg = makePg();
    const storage = makeStorage();
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: LONG, tokens: 700, costUsd: 0.2 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      storage as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Тарифы', '');
    await svc.drainForTests();

    expect(storage.uploads).toHaveLength(1);
    expect(storage.uploads[0].key).toMatch(/^documents\/user-1\/.+\.md$/);
    // text/plain, иначе браузер предложит скачать вместо показа.
    expect(storage.uploads[0].contentType).toBe('text/plain; charset=utf-8');
    expect(storage.uploads[0].body).toContain('# Тарифы');

    const content = docRow(pg.history).content;
    expect(content).toContain('[Открыть документ полностью](https://');
    expect(content.length).toBeLessThan(LONG.length);
  });

  it('короткий документ не режется', async () => {
    const pg = makePg();
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'Три коротких слова.', tokens: 5, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Заметка', '');
    await svc.drainForTests();

    expect(docRow(pg.history).content).toContain('Три коротких слова.');
    expect(docRow(pg.history).content).not.toContain('…');
  });

  it('упавшее хранилище не теряет документ — текст ложится в ленту целиком', async () => {
    const pg = makePg();
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: LONG, tokens: 700, costUsd: 0.2 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage(true) as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Тарифы', '');
    await svc.drainForTests();

    expect(pg.history).toHaveLength(1);
    expect(docRow(pg.history).content).toContain(LONG.trim().slice(0, 40));
    expect(docRow(pg.history).content).not.toContain('Открыть документ');
  });

  it('ссылка едет Роману вместе с готовностью', async () => {
    const lk = { send: jest.fn(async () => {}) };
    const svc = new VoiceDocumentService(
      makePg() as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 5, costUsd: 0 })) } as any,
      lk as any,
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Тарифы', '');
    await svc.drainForTests();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'document_ready', url: expect.stringContaining('https://') }),
    );
  });
});

describe('автор определяется сам, если Роман его не назвал', () => {
  const CALL = '11111111-1111-1111-1111-111111111111';
  const ROOM = 'voice_room';

  it('документ уходит последнему консультанту звонка', async () => {
    // Роман спросил Шанкару, назвал документ «по рекомендациям Шанкары» — и
    // оформил от себя: параметр specialist он игнорирует. Живой звонок
    // 27.08.2026. На послушание модели тут полагаться нельзя.
    const pg = makePg([jobDoneMinutesAgo(13, 1, { question: 'q', answer: 'a' })]);
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 5, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Окна запуска', ''); // имени НЕ передаём
    await svc.drainForTests();

    expect(docRow(pg.history).session_id).toBe('user-1_13');
  });

  it('явно названный специалист важнее догадки', async () => {
    const pg = makePg([{ specialist_agent_id: 13, question: 'q', answer: 'a' }]);
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 5, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Тарифы', '', 'Виталий');
    await svc.drainForTests();

    expect(docRow(pg.history).session_id).toBe('user-1_17');
  });

  it('давняя консультация автором не считается — пишет ведущий', async () => {
    // Встреча 28.08.2026: единственной консультацией был вопрос про сервис
    // Priem.io техническому директору, а через шесть с половиной минут
    // попросили договор купли-продажи автомобиля. Догадка связала их только по
    // порядку следования, и договор ушёл в чат к техдиру. Юрист, чья это тема,
    // о договоре так и не узнал, а владелец не смог добиться ответа на вопрос
    // «кто его подготовил».
    const pg = makePg([jobDoneMinutesAgo(19, 7, { question: 'q', answer: 'a' })]);
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 5, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Договор купли-продажи автомобиля', '');
    await svc.drainForTests();

    expect(docRow(pg.history).session_id).toBe(`user-1_${HOST_AGENT_ID}`);
  });

  it('свежая консультация выигрывает у протухшей', async () => {
    // Протухшая строка не должна попадать в выборку вовсе. Иначе LIMIT 1
    // возвращает её первой и автором становится не тот, с кем только что
    // говорили.
    const pg = makePg([
      jobDoneMinutesAgo(19, 8, { question: 'q1', answer: 'a1' }),
      jobDoneMinutesAgo(13, 2, { question: 'q2', answer: 'a2' }),
    ]);
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 5, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Окна запуска', '');
    await svc.drainForTests();

    expect(docRow(pg.history).session_id).toBe('user-1_13');
  });

  it('тул возвращает Роману настоящего автора, а не эхо параметра', async () => {
    // Тот же корень, что и у промаха с техдиром, но с другой стороны. Раньше
    // наружу уходил тот specialist, что пришёл на вход: имени не передали —
    // вернулась пустота, и Роман считал, что пишет сам. На вопрос «кто его
    // подготовил» он отвечал из этого убеждения, а документ лежал в чужом
    // чате. Ответ тула и место документа обязаны сходиться.
    const pg = makePg([jobDoneMinutesAgo(13, 1, { question: 'q', answer: 'a' })]);
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 5, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage() as any,
      makeLang() as any,
    );

    const res = await svc.create(CALL, ROOM, 'user-1', 'Окна запуска', ''); // имени НЕ передаём
    await svc.drainForTests();

    expect(res).toMatchObject({ status: 'accepted', specialist: 'Шанкара' });
    expect(docRow(pg.history).session_id).toBe('user-1_13');
  });

  it('консультаций не было — пишет ведущий', async () => {
    const pg = makePg();
    const svc = new VoiceDocumentService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'тело', tokens: 5, costUsd: 0 })) } as any,
      { send: jest.fn(async () => {}) } as any,
      makeStorage() as any,
      makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Заметка', '');
    await svc.drainForTests();

    expect(docRow(pg.history).session_id).toBe(`user-1_${HOST_AGENT_ID}`);
  });
});

describe('видно, что специалист работает', () => {
  const CALL = '11111111-1111-1111-1111-111111111111';
  const ROOM = 'voice_room';

  it('задание попадает в чат автора ДО того, как документ написан', async () => {
    // Раньше в чате появлялся только готовый документ, а пока он сочинялся —
    // до пяти минут — там не было ничего, и выглядело это как «запрос не
    // дошёл». Владелец 27.08.2026.
    const pg = makePg();
    let resolveDoc: (v: any) => void = () => {};
    const chat = {
      generateAgentReplyWithCharge: jest.fn(() => new Promise((r) => { resolveDoc = r; })),
    };
    const svc = new VoiceDocumentService(
      pg as any, chat as any, { send: jest.fn(async () => {}) } as any,
      makeStorage() as any, makeLang() as any,
    );

    await svc.create(CALL, ROOM, 'user-1', 'Сроки поездки', 'по датам', 'Шанкара');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Документ ещё пишется, а задание уже видно.
    expect(pg.history).toHaveLength(1);
    expect(pg.history[0]).toMatchObject({ session_id: 'user-1_13', sender_type: 'human' });
    expect(pg.history[0].content).toContain('Сроки поездки');
    expect(pg.history[0].content).toContain('по датам');

    resolveDoc({ text: 'тело', tokens: 5, costUsd: 0 });
    await svc.drainForTests();
    expect(pg.history).toHaveLength(2); // и готовый документ следом
  });
});
