import { ShortsCron } from './shorts.cron';

function setup() {
  // claimStage('directing') отдаёт ролик, claimStage('writing') — ничего; остальное — запись.
  const pg = {
    query: jest.fn(async (_sql: string, params: any[] = []) =>
      params[0] === 'directing'
        ? { rows: [{ id: 'v1', status: 'directing', attempts: 1, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't' }] }
        : { rows: [], rowCount: 1 }),
  };
  const topics = { refillWeek: jest.fn(async () => 3), start: jest.fn(async (): Promise<any> => null) };
  const director = { direct: jest.fn(async () => { throw new Error('релей молчит'); }) };
  const writer = { write: jest.fn(async () => {}) };
  const approval = { sendPendingReviews: jest.fn(async () => {}), notifyFailures: jest.fn(async () => {}) };
  const publisher = { rearmStuck: jest.fn(async () => {}), publishDue: jest.fn(async () => {}) };
  const cron = new ShortsCron(pg as any, topics as any, director as any, writer as any, approval as any, publisher as any);
  return { cron, pg, topics, director, writer, approval, publisher };
}

describe('ShortsCron', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.SHORTS_ENABLED;
    delete process.env.SHORTS_AUTO_TOPICS;
  });
  afterAll(() => {
    process.env = env;
  });

  it('без SHORTS_ENABLED — ни одного действия', async () => {
    const d = setup();
    await d.cron.refillTopics();
    await d.cron.prepare();
    await d.cron.work();
    await d.cron.publishDue();
    expect(d.pg.query).not.toHaveBeenCalled();
    expect(d.topics.start).not.toHaveBeenCalled();
    expect(d.publisher.publishDue).not.toHaveBeenCalled();
  });

  it('включено без автозапуска: конвейер идёт, очередь сама не наполняется', async () => {
    process.env.SHORTS_ENABLED = 'true';
    const d = setup();
    await d.cron.refillTopics();
    await d.cron.prepare();
    expect(d.topics.refillWeek).not.toHaveBeenCalled();
    expect(d.topics.start).not.toHaveBeenCalled();

    await d.cron.work();
    expect(d.director.direct).toHaveBeenCalledTimes(1);
    const retry = d.pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('make_interval(secs => $3)')) as any[];
    expect(retry[1]).toEqual(['v1', 'directing', 60, 'режиссёр: релей молчит', 1]);
    expect(d.writer.write).not.toHaveBeenCalled();
    expect(d.approval.sendPendingReviews).toHaveBeenCalled();
    expect(d.approval.notifyFailures).toHaveBeenCalled();

    await d.cron.publishDue();
    expect(d.publisher.rearmStuck).toHaveBeenCalled();
    expect(d.publisher.publishDue).toHaveBeenCalled();
  });

  it('с автозапуском — наполнение недели и запуск к слоту без обхода ограничений', async () => {
    process.env.SHORTS_ENABLED = 'true';
    process.env.SHORTS_AUTO_TOPICS = 'true';
    const d = setup();
    await d.cron.refillTopics();
    await d.cron.prepare();
    expect(d.topics.refillWeek).toHaveBeenCalled();
    expect(d.topics.start).toHaveBeenCalledWith({ force: false });
  });

  it('сбой одного шага не останавливает следующие', async () => {
    process.env.SHORTS_ENABLED = 'true';
    const d = setup();
    d.approval.sendPendingReviews.mockRejectedValue(new Error('Telegram лежит'));
    await d.cron.work();
    expect(d.approval.notifyFailures).toHaveBeenCalled();
  });
});
