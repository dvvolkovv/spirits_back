import { ShortsTopicService } from './shorts-topic.service';

const AGENTS = [
  { id: 1, name: 'Миша', description: 'Коуч' },
  { id: 10, name: 'Алексей', description: 'Юрист' },
  { id: 22, name: 'Кира', description: 'Дизайнер' },
  { id: 4, name: 'Ирина', description: 'Карьера' },
];
const SETTINGS = { slotDays: [2, 4, 6], slotHourMsk: 18, prepareLeadHours: 24 };
const MON_NOON = new Date('2026-10-26T12:00:00.000Z'); // до вт 18:00 МСК — 27 ч
const MON_EVENING = new Date('2026-10-26T17:00:00.000Z'); // до вт 18:00 МСК — 22 ч
const TUE = '2026-10-27T15:00:00.000Z';

const ideaRow = (over: Record<string, any> = {}) => ({
  id: 'i1', rubric: 'assistant', angle: 'calm', angle_locked: false, source: 'catalog', topic_key: 't',
  assistant_id: 10, status: 'idea', created_at: '2026-10-20T00:00:00.000Z', ...over,
});

/** Транзакция-заглушка: ответ — по первому совпавшему кусочку SQL. */
function fakeTx(routes: Array<[string, any]>) {
  const seen: Array<{ sql: string; params: any[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      const hit = routes.find(([needle]) => sql.includes(needle));
      return hit ? hit[1] : { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  return { getClient: async () => client, seen };
}

function setup(tx: ReturnType<typeof fakeTx>, poolQuery = jest.fn(async () => ({ rows: [] }))) {
  const pg = { query: poolQuery, getClient: tx.getClient };
  const agents = { getAgents: jest.fn(async () => AGENTS) };
  const settings = { get: jest.fn(async () => SETTINGS) };
  return new ShortsTopicService(pg as any, agents as any, settings as any);
}

describe('ShortsTopicService.addManual', () => {
  const insertOnly = () => {
    const query = jest.fn(async (_sql: string, params: any[]) => ({ rows: [{ ...ideaRow(), id: 'new', source: 'manual', source_ref: params[4] }] }));
    return { svc: setup(fakeTx([]), query), query };
  };

  it('история из /short — рубрика case, подача по ритму, ключ сообщения', async () => {
    const { svc, query } = insertOnly();
    await svc.addManual({ topic: 'Как я спорил с арендодателем о залоге', sourceRef: 'tg:1:2' });
    const params = (query.mock.calls[0] as any[])[1];
    expect(params.slice(0, 5)).toEqual(['case', 'calm', false, 'manual', 'tg:1:2']);
    expect(params[7]).toBe('Как я спорил с арендодателем о залоге');
  });

  it('подача из заказа фиксируется', async () => {
    const { svc, query } = insertOnly();
    await svc.addManual({ topic: 'Разнос плохого договора', rubric: 'assistant', angle: 'roast', assistantId: 10 });
    const params = (query.mock.calls[0] as any[])[1];
    expect(params.slice(0, 3)).toEqual(['assistant', 'roast', true]);
    expect(params[8]).toBe(10);
  });

  it.each([
    [{ topic: 'коротко' }, /от 10 до 4000/],
    [{ topic: 'нормальная тема ролика', rubric: 'boom' }, /рубрика/],
    [{ topic: 'нормальная тема ролика', angle: 'boom' }, /подача/],
    [{ topic: 'нормальная тема ролика', assistantId: 99 }, /ассистента 99 нет/],
  ])('%j — ошибка', async (order, message) => {
    const { svc } = insertOnly();
    await expect(svc.addManual(order as any)).rejects.toThrow(message);
  });
});

describe('ShortsTopicService.refillWeek', () => {
  it('три давно не показанных ассистента, кроме тех, у кого уже есть идея', async () => {
    const inserted: any[] = [];
    const query = jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('max(created_at)')) return { rows: [{ assistant_id: 10, last: '2026-10-01T00:00:00Z' }] };
      if (sql.includes('DISTINCT assistant_id')) return { rows: [{ assistant_id: 4 }] };
      if (sql.startsWith('INSERT')) {
        inserted.push(params);
        return { rows: [ideaRow({ id: `n${inserted.length}` })] };
      }
      return { rows: [] };
    });
    const added = await setup(fakeTx([]), query).refillWeek(new Date('2026-10-25T07:00:00Z'));
    expect(added).toBe(3);
    expect(inserted.map((p) => p[8])).toEqual([1, 22, 10]);
    expect(inserted[0][4]).toBe('catalog:assistant:1:2026-10-25');
    expect(inserted[0].slice(0, 4)).toEqual(['assistant', 'calm', false, 'catalog']);
  });
});

describe('ShortsTopicService.start', () => {
  // UPDATE — раньше выборки идей: в нём тоже есть «status = 'idea'».
  const routes = (over: Array<[string, any]> = []) => fakeTx([
    ...over,
    ['pg_try_advisory_xact_lock', { rows: [{ ok: true }] }],
    ['UPDATE short_video', { rows: [ideaRow({ status: 'directing', slot_at: TUE, angle: 'uncomfortable' })], rowCount: 1 }],
    ['SELECT slot_at FROM short_video', { rows: [] }],
    ['count(*)', { rows: [{ n: 0 }] }],
    ["status = 'idea'", { rows: [ideaRow()] }],
    ['SELECT rubric, angle', { rows: [] }],
  ]);

  it('до свободного слота меньше суток — запуск в этот слот с подачей по ритму', async () => {
    const tx = routes();
    const v = await setup(tx).start({ force: false }, () => MON_EVENING);
    expect(v?.status).toBe('directing');
    const update = tx.seen.find((q) => q.sql.includes('UPDATE short_video'));
    expect(update.params).toEqual(['i1', TUE, 'uncomfortable']);
  });

  it('до слота больше суток — крон ждёт, start_now — запускает', async () => {
    expect(await setup(routes()).start({ force: false }, () => MON_NOON)).toBeNull();
    expect((await setup(routes()).start({ force: true }, () => MON_NOON))?.status).toBe('directing');
  });

  it('в работе уже два ролика — крон не запускает третий', async () => {
    expect(await setup(routes([['count(*)', { rows: [{ n: 2 }] }]])).start({ force: false }, () => MON_EVENING)).toBeNull();
  });

  it('соседний процесс уже решает запуск — null без записи', async () => {
    const tx = routes([['pg_try_advisory_xact_lock', { rows: [{ ok: false }] }]]);
    expect(await setup(tx).start({ force: true }, () => MON_EVENING)).toBeNull();
    expect(tx.seen.some((q) => q.sql.includes('UPDATE short_video'))).toBe(false);
  });

  it('слот, предназначенный другому ролику, пропускается', async () => {
    const tx = routes([['SELECT slot_at FROM short_video', { rows: [{ slot_at: new Date(TUE) }] }]]);
    await setup(tx).start({ force: true }, () => MON_EVENING);
    const update = tx.seen.find((q) => q.sql.includes('UPDATE short_video'));
    expect(update.params[1]).toBe('2026-10-29T15:00:00.000Z');
  });
});
