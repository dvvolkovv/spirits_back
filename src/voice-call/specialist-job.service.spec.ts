import { SpecialistJobService } from './specialist-job.service';
import {
  findSpecialist, SPECIALIST_ROLES, SPECIALISTS, VOICE_ASK_NOTE, VOICE_BRIEF,
} from './voice-call.types';

/** Заглушка PgService: помнит job'ы и строки истории в памяти. */
function makePg() {
  const jobs: any[] = [];
  const history: any[] = [];
  const charges: any[] = [];
  return {
    jobs,
    history,
    charges,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO custom_chat_history/i.test(sql)) {
        history.push({ session_id: params[0], agent: params[1], content: params[2], sender_type: /'human'/.test(sql) ? 'human' : 'ai' });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO token_consumption_tasks/i.test(sql)) {
        charges.push({ user_id: params[1], agent_id: params[2], output_tokens: params[3], metadata: JSON.parse(params[4]) });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO voice_call_jobs/i.test(sql)) {
        jobs.push({ id: params[0], call_id: params[1], specialist_agent_id: params[2], status: 'queued' });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE voice_call_jobs/i.test(sql)) {
        const j = jobs.find((x) => x.id === params[params.length - 1]);
        // Статус берём из самого SQL. Раньше здесь была альтернатива
        // /status\s*=\s*'done'|\$1/, и ветка `$1` матчилась на ЛЮБОЙ
        // параметризованный запрос — переход в 'running' помечал job
        // завершённым, из-за чего мок врал про число активных job.
        const m = /SET\s+status\s*=\s*'(\w+)'/i.exec(sql);
        if (j && m) j.status = m[1];
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT count/i.test(sql)) {
        const pending = jobs.filter((x) => x.status === 'queued' || x.status === 'running').length;
        return { rows: [{ count: String(pending) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

/** Заглушка LanguageService. */
function makeLang(language = 'ru') {
  return { resolveUserLanguage: jest.fn(async () => language) };
}

describe('состав списка специалистов', () => {
  it('у каждого специалиста есть описание роли', () => {
    // Без роли Роман выбирает по имени наугад: 26.08.2026 юридический вопрос
    // уехал бухгалтеру, а архитектура телефонии — юристу. Добавить имя в
    // SPECIALISTS и забыть про SPECIALIST_ROLES — ровно этот сценарий.
    const withoutRole = Object.keys(SPECIALISTS).filter((n) => !SPECIALIST_ROLES[n]?.trim());
    expect(withoutRole).toEqual([]);
  });

  it('описания не приписаны тем, кого нет в списке', () => {
    const orphans = Object.keys(SPECIALIST_ROLES).filter((n) => !SPECIALISTS[n]);
    expect(orphans).toEqual([]);
  });

  it('id уникальны — иначе вопрос уходит не тому', () => {
    const ids = Object.values(SPECIALISTS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ведущий не может спросить сам себя', () => {
    // HOST_AGENT_ID = 12 (Роман). Попади он в список — получилась бы петля.
    expect(Object.values(SPECIALISTS)).not.toContain(12);
  });

  it('технический директор на месте', () => {
    expect(findSpecialist('Дмитрий')).toBe(19);
  });
});

describe('SpecialistJobService', () => {
  const ROOM = 'voice_test_room';
  const CALL = '11111111-1111-1111-1111-111111111111';

  it('ask() отвечает быстро и НЕ вызывает LLM синхронно', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'ответ юриста', tokens: 1200, costUsd: 0.33 })) };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any, makeLang() as any);

    const started = Date.now();
    const res = await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'Можно ли так?');
    const elapsed = Date.now() - started;

    expect(res).toMatchObject({ status: 'asked', specialist: 'Алексей' });
    expect(elapsed).toBeLessThan(200);
    // Главное: на момент ответа модель ещё не звали.
    expect(chat.generateAgentReplyWithCharge).not.toHaveBeenCalled();
  });

  it('после завершения job ответ уходит в комнату', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'ответ юриста', tokens: 1200, costUsd: 0.33 })) };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any, makeLang() as any);

    const res = await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'Можно ли так?');
    await svc.drainForTests();

    expect(chat.generateAgentReplyWithCharge).toHaveBeenCalledTimes(1);
    const sent = lk.send.mock.calls.map((c: any[]) => c[1]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'specialist_pending' }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'specialist_answer',
      specialist: 'Алексей',
      text: 'ответ юриста',
      jobId: (res as any).jobId,
    }));
  });

  it('каждый job получает изолированную сессию — иначе релей отдаёт пустой поток', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'ok', tokens: 1200, costUsd: 0.33 })) };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any, makeLang() as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'вопрос один');
    await svc.ask(CALL, ROOM, 'user-1', 'Анна', 'вопрос два');
    await svc.drainForTests();

    const sessions = chat.generateAgentReplyWithCharge.mock.calls.map((c: any[]) => c[3]);
    expect(sessions.every((s: string) => typeof s === 'string' && s.length > 0)).toBe(true);
    expect(new Set(sessions).size).toBe(2);
  });

  it('падение специалиста превращается в specialist_failed, а не в исключение', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => { throw new Error('релей лёг'); }) };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any, makeLang() as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'вопрос');
    await expect(svc.drainForTests()).resolves.toBeUndefined();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'specialist_failed', reason: 'error' }),
    );
  });

  it('личные ассистенты тоже доступны — не только деловая пятёрка', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'карта говорит', tokens: 1200, costUsd: 0.33 })) };
    const svc = new SpecialistJobService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeLang() as any);

    // Шанкара — ведический астролог, id 13. Первая редакция списка включала
    // только business-ассистентов, и весь personal-блок был недоступен.
    const res = await svc.ask(CALL, ROOM, 'user-1', 'Шанкара', 'Что по периодам?');
    await svc.drainForTests();

    expect(res).toMatchObject({ status: 'asked', specialist: 'Шанкара' });
    expect(pg.jobs[0].specialist_agent_id).toBe(13);
  });

  it('имя опознаётся без учёта регистра — модель диктует его из речи', async () => {
    const pg = makePg();
    const svc = new SpecialistJobService(pg as any, { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'ok', tokens: 1200, costUsd: 0.33 })) } as any, { send: jest.fn(async () => {}) } as any, makeLang() as any);

    const res = await svc.ask(CALL, ROOM, 'user-1', '  шанкара ', 'вопрос');
    await svc.drainForTests();

    expect(res).toMatchObject({ status: 'asked' });
    expect(pg.jobs[0].specialist_agent_id).toBe(13);
  });

  it('неизвестный специалист отклоняется без создания job', async () => {
    const pg = makePg();
    const svc = new SpecialistJobService(pg as any, { generateAgentReplyWithCharge: jest.fn() } as any, { send: jest.fn() } as any, makeLang() as any);
    const res = await svc.ask(CALL, ROOM, 'user-1', 'Гэндальф', 'вопрос');
    expect(res).toEqual({ status: 'rejected', reason: 'unknown_specialist' });
    expect(pg.jobs).toHaveLength(0);
  });

  it('лимита параллельных вопросов нет — пятый тоже проходит', async () => {
    // Ограничение в три снято по решению владельца 26.08.2026. Тест держит
    // именно снятие: пока стоял лимит, четвёртый возвращал too_many_pending.
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(() => new Promise<never>(() => {})) }; // висят
    const svc = new SpecialistJobService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeLang() as any);

    const names = ['Алексей', 'Анна', 'Виталий', 'Андрей', 'Александра'];
    const results = [];
    for (const n of names) results.push(await svc.ask(CALL, ROOM, 'u', n, 'вопрос'));

    expect(results.every((r) => r.status === 'asked')).toBe(true);
    expect(pg.jobs).toHaveLength(5);
  });

  it('консультация попадает в обычный чат со специалистом, с пометкой про голос', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'коротко: так можно', tokens: 1200, costUsd: 0.33 })) };
    const svc = new SpecialistJobService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeLang() as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'Можно ли так?');
    await svc.drainForTests();

    // Алексей — agent id 10, значит сессия обычного чата с ним.
    expect(pg.history).toEqual([
      expect.objectContaining({
        session_id: 'user-1_10',
        sender_type: 'human',
        content: `${VOICE_ASK_NOTE.ru}\n\nМожно ли так?`,
      }),
      expect.objectContaining({
        session_id: 'user-1_10',
        sender_type: 'ai',
        content: 'коротко: так можно',
      }),
    ]);
  });

  it('пометка пишется на языке пользователя, а не всегда по-русски', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'short answer', tokens: 1200, costUsd: 0.33 })) };
    const svc = new SpecialistJobService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeLang('en') as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'May I?');
    await svc.drainForTests();

    expect(pg.history[0].content).toBe(`${VOICE_ASK_NOTE.en}\n\nMay I?`);
    expect(pg.history[0].content).not.toContain(VOICE_ASK_NOTE.ru);
  });

  it('модель просят ответить коротко, но в историю идёт чистый вопрос', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'ок', tokens: 1200, costUsd: 0.33 })) };
    const svc = new SpecialistJobService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeLang() as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'Можно ли так?');
    await svc.drainForTests();

    // В модель — с требованием краткости: без него специалисты писали
    // трактаты по 15 000 знаков и не укладывались в таймаут.
    const [sentToModel] = chat.generateAgentReplyWithCharge.mock.calls.map((c: any[]) => c[2]);
    expect(sentToModel).toContain(VOICE_BRIEF);
    expect(sentToModel).toContain('Можно ли так?');
    // А в чат — вопрос Романа без нашей служебки.
    expect(pg.history[0].content).not.toContain(VOICE_BRIEF);
  });

  it('сбой записи в историю не срывает ответ в комнату', async () => {
    const pg = makePg();
    const real = pg.query;
    pg.query = jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO custom_chat_history/i.test(sql)) throw new Error('база моргнула');
      return real(sql, params);
    }) as any;
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'ответ', tokens: 1200, costUsd: 0.33 })) } as any, lk as any, makeLang() as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'вопрос');
    await svc.drainForTests();

    // Ответ уже прозвучал бы в разговоре — падать из-за истории нельзя.
    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'specialist_answer', text: 'ответ' }),
    );
  });
});

describe('списание за консультацию', () => {
  const ROOM = 'voice_test_room';
  const CALL = '11111111-1111-1111-1111-111111111111';

  it('расход попадает в строку списания и в сообщение комнате', async () => {
    // До 26.08.2026 консультации во время звонка не тарифицировались вовсе:
    // generateAgentReply забирал текст, а costUsd и usage выбрасывал. Голос
    // работал бесплатным каналом к платным ассистентам.
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'коротко', tokens: 3200, costUsd: 0.9 })) };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any, makeLang() as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Виталий', 'вопрос');
    await svc.drainForTests();

    expect(pg.charges).toHaveLength(1);
    expect(pg.charges[0]).toMatchObject({
      user_id: 'user-1',
      agent_id: 17,
      output_tokens: 3200,
      metadata: { kind: 'voice_specialist', specialist: 'Виталий' },
    });
    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'specialist_answer', tokens: 3200 }),
    );
  });

  it('за неотвеченную консультацию не списывается ничего', async () => {
    const pg = makePg();
    const chat = { generateAgentReplyWithCharge: jest.fn(async () => { throw new Error('таймаут'); }) };
    const svc = new SpecialistJobService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any, makeLang() as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Виталий', 'вопрос');
    await svc.drainForTests();

    expect(pg.charges).toHaveLength(0);
  });

  it('сбой записи списания не роняет job — ответ всё равно звучит', async () => {
    const pg = makePg();
    const real = pg.query;
    pg.query = jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO token_consumption_tasks/i.test(sql)) throw new Error('база моргнула');
      return real(sql, params);
    }) as any;
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(
      pg as any,
      { generateAgentReplyWithCharge: jest.fn(async () => ({ text: 'ответ', tokens: 500, costUsd: 0.1 })) } as any,
      lk as any,
      makeLang() as any,
    );

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'вопрос');
    await svc.drainForTests();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'specialist_answer', text: 'ответ' }),
    );
  });
});
