import { SpecialistJobService } from './specialist-job.service';

/** Заглушка PgService: помнит job'ы в памяти. */
function makePg() {
  const jobs: any[] = [];
  return {
    jobs,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO voice_call_jobs/i.test(sql)) {
        jobs.push({ id: params[0], call_id: params[1], specialist_agent_id: params[2], status: 'queued' });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE voice_call_jobs/i.test(sql)) {
        const j = jobs.find((x) => x.id === params[params.length - 1]);
        if (j) j.status = /status\s*=\s*'done'|\$1/i.test(sql) ? 'done' : j.status;
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

describe('SpecialistJobService', () => {
  const ROOM = 'voice_test_room';
  const CALL = '11111111-1111-1111-1111-111111111111';

  it('ask() отвечает быстро и НЕ вызывает LLM синхронно', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => 'ответ юриста') };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any);

    const started = Date.now();
    const res = await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'Можно ли так?');
    const elapsed = Date.now() - started;

    expect(res).toMatchObject({ status: 'asked', specialist: 'Алексей' });
    expect(elapsed).toBeLessThan(200);
    // Главное: на момент ответа модель ещё не звали.
    expect(chat.generateAgentReply).not.toHaveBeenCalled();
  });

  it('после завершения job ответ уходит в комнату', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => 'ответ юриста') };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any);

    const res = await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'Можно ли так?');
    await svc.drainForTests();

    expect(chat.generateAgentReply).toHaveBeenCalledTimes(1);
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
    const chat = { generateAgentReply: jest.fn(async () => 'ok') };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'вопрос один');
    await svc.ask(CALL, ROOM, 'user-1', 'Анна', 'вопрос два');
    await svc.drainForTests();

    const sessions = chat.generateAgentReply.mock.calls.map((c: any[]) => c[3]);
    expect(sessions.every((s: string) => typeof s === 'string' && s.length > 0)).toBe(true);
    expect(new Set(sessions).size).toBe(2);
  });

  it('падение специалиста превращается в specialist_failed, а не в исключение', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => { throw new Error('релей лёг'); }) };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'вопрос');
    await expect(svc.drainForTests()).resolves.toBeUndefined();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'specialist_failed', reason: 'error' }),
    );
  });

  it('неизвестный специалист отклоняется без создания job', async () => {
    const pg = makePg();
    const svc = new SpecialistJobService(pg as any, { generateAgentReply: jest.fn() } as any, { send: jest.fn() } as any);
    const res = await svc.ask(CALL, ROOM, 'user-1', 'Гэндальф', 'вопрос');
    expect(res).toEqual({ status: 'rejected', reason: 'unknown_specialist' });
    expect(pg.jobs).toHaveLength(0);
  });

  it('четвёртый параллельный вопрос отклоняется', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(() => new Promise<string>(() => {})) }; // висит
    const svc = new SpecialistJobService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    await svc.ask(CALL, ROOM, 'u', 'Алексей', 'раз');
    await svc.ask(CALL, ROOM, 'u', 'Анна', 'два');
    await svc.ask(CALL, ROOM, 'u', 'Виталий', 'три');
    const fourth = await svc.ask(CALL, ROOM, 'u', 'Андрей', 'четыре');

    expect(fourth).toEqual({ status: 'rejected', reason: 'too_many_pending' });
  });
});
