import { ShortOrderError, ShortsTopicService } from './shorts-topic.service';

const AGENTS = [
  { id: 1, name: 'Миша', description: 'Коуч — цели, привычки и источники мотивации' },
  { id: 10, name: 'Алексей', description: 'Юрист — договоры, споры и работа с судами' },
  { id: 22, name: 'Кира', description: 'Дизайнер — логотипы, фирменный стиль и макеты' },
  { id: 4, name: 'Ирина', description: 'Карьера — резюме, собеседования и переговоры' },
  { id: 7, name: 'Полина', description: 'Врач-терапевт — симптомы, анализы и профилактика' },
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

function setup(tx: ReturnType<typeof fakeTx>, poolQuery = jest.fn(async () => ({ rows: [] })), agentsList: any[] = AGENTS) {
  const pg = { query: poolQuery, getClient: tx.getClient };
  const agents = { getAgents: jest.fn(async () => agentsList) };
  const settings = { get: jest.fn(async () => SETTINGS) };
  return new ShortsTopicService(pg as any, agents as any, settings as any);
}

describe('ShortOrderError', () => {
  it('отдельный класс с name = ShortOrderError', () => {
    const e = new ShortOrderError('упс');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ShortOrderError');
    expect(e.message).toBe('упс');
  });
});

describe('ShortsTopicService.addManual', () => {
  /** dupRows — ответ на дедуп-проверку «уже есть открытая ручная идея с этим topic_key». */
  const insertOnly = (dupRows: any[] = []) => {
    const query = jest.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith('SELECT')) return { rows: dupRows };
      return { rows: [{ ...ideaRow(), id: 'new', source: 'manual', source_ref: params[4] }] };
    });
    return { svc: setup(fakeTx([]), query), query };
  };
  const insertParams = (query: jest.Mock) => {
    const call = query.mock.calls.find(([sql]: [string]) => sql.startsWith('INSERT'));
    return call ? call[1] : undefined;
  };

  it('история из /short — рубрика case, подача по ритму, ключ сообщения', async () => {
    const { svc, query } = insertOnly();
    await svc.addManual({ topic: 'Как я спорил с арендодателем о залоге', sourceRef: 'tg:1:2' });
    // sourceRef задан — дедуп-проверка по topic_key не запускается, единственный запрос — вставка.
    expect(query.mock.calls.filter(([sql]: [string]) => sql.startsWith('SELECT'))).toHaveLength(0);
    const params = insertParams(query);
    expect(params.slice(0, 5)).toEqual(['case', 'calm', false, 'manual', 'tg:1:2']);
    expect(params[7]).toBe('Как я спорил с арендодателем о залоге');
  });

  it('подача из заказа фиксируется', async () => {
    const { svc, query } = insertOnly();
    await svc.addManual({ topic: 'Разнос плохого договора', rubric: 'assistant', angle: 'roast', assistantId: 10 });
    const params = insertParams(query);
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

  it('ошибки проверки входа — экземпляр ShortOrderError', async () => {
    const { svc } = insertOnly();
    await expect(svc.addManual({ topic: 'коротко' })).rejects.toBeInstanceOf(ShortOrderError);
  });

  it('здоровье + провокационная подача — отказ сразу, ассистент базы не трогается', async () => {
    const { svc, query } = insertOnly();
    const order = { topic: 'нормальная тема ролика про бессонницу', assistantId: 7, angle: 'roast' as const };
    await expect(svc.addManual(order)).rejects.toThrow('«Полина» — тема здоровья: только спокойная подача (calm)');
    await expect(svc.addManual(order)).rejects.toBeInstanceOf(ShortOrderError);
    expect(query.mock.calls.some(([sql]: [string]) => sql.startsWith('INSERT'))).toBe(false);
  });

  it('тема здоровья без заданной подачи — проходит, подачу поставит ритм', async () => {
    const { svc, query } = insertOnly();
    await svc.addManual({ topic: 'нормальная тема ролика про бессонницу', assistantId: 7 });
    const params = insertParams(query);
    expect(params.slice(0, 3)).toEqual(['case', 'calm', false]);
    expect(params[8]).toBe(7);
  });

  it('тема здоровья со спокойной подачей — проходит', async () => {
    const { svc, query } = insertOnly();
    await svc.addManual({ topic: 'нормальная тема ролика про бессонницу', assistantId: 7, angle: 'calm' });
    const params = insertParams(query);
    expect(params.slice(0, 3)).toEqual(['case', 'calm', true]);
  });

  it('двойное «Заказать» без sourceRef с тем же topic_key — вторая заявка не заводится', async () => {
    const { svc, query } = insertOnly([{ id: 'уже-открытая' }]);
    const v = await svc.addManual({ topic: 'Повторная тема без ссылки на источник' });
    expect(v).toBeNull();
    expect(query.mock.calls.some(([sql]: [string]) => sql.startsWith('INSERT'))).toBe(false);
  });
});

describe('ShortsTopicService.refillWeek', () => {
  /** routes — доп. ответы по кусочку SQL; INSERT считается отдельно в inserted. */
  function refillSetup(routes: Array<[string, any]>, agentsList: any[] = AGENTS) {
    const inserted: any[] = [];
    const query = jest.fn(async (sql: string, params: any[] = []) => {
      const hit = routes.find(([needle]) => sql.includes(needle));
      if (hit) return hit[1];
      if (sql.startsWith('INSERT')) {
        inserted.push(params);
        return { rows: [ideaRow({ id: `n${inserted.length}` })] };
      }
      return { rows: [] };
    });
    return { svc: setup(fakeTx([]), query, agentsList), query, inserted };
  }

  it('открытых идей каталога уже три — ничего не заводит, до других запросов не доходит', async () => {
    const { svc, query, inserted } = refillSetup([
      ["status = 'idea' AND source = 'catalog'", { rows: [{ n: 3 }] }],
    ]);
    const added = await svc.refillWeek(new Date('2026-10-25T07:00:00.000Z'));
    expect(added).toBe(0);
    expect(inserted).toHaveLength(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('открыта одна идея каталога — доводит до трёх, ключи недели по позиции', async () => {
    const { svc, query, inserted } = refillSetup([
      ["status = 'idea' AND source = 'catalog'", { rows: [{ n: 1 }] }],
      ['coalesce(slot_at, created_at)', { rows: [
        { assistant_id: 1, last: '2026-01-01T00:00:00Z' },
        { assistant_id: 22, last: '2026-09-01T00:00:00Z' },
        { assistant_id: 10, last: '2026-10-01T00:00:00Z' },
      ] }],
      // Ирина (4) уже в очереди — пропускается, независимо от того, когда её показывали.
      ['DISTINCT assistant_id', { rows: [{ assistant_id: 4 }] }],
    ]);
    const added = await svc.refillWeek(new Date('2026-10-25T07:00:00.000Z'));
    expect(added).toBe(2);
    // Полина (7) никогда не показывалась — идёт первой, затем Миша (1, с 1 января).
    expect(inserted.map((p) => p[8])).toEqual([7, 1]);
    expect(inserted[0][4]).toBe('catalog:2026-W43:2');
    expect(inserted[1][4]).toBe('catalog:2026-W43:3');
    expect(inserted[0].slice(0, 4)).toEqual(['assistant', 'calm', false, 'catalog']);

    const shownCall = query.mock.calls.find(([sql]: [string]) => sql.includes('coalesce(slot_at, created_at)'));
    expect(shownCall[0]).toContain("status <> 'failed'");
    expect(shownCall[0]).not.toContain("'rejected'");
  });

  it('неделя считается по МСК, не по UTC', async () => {
    const { svc, inserted } = refillSetup([
      ["status = 'idea' AND source = 'catalog'", { rows: [{ n: 2 }] }],
    ]);
    // 25.10 22:00 UTC = 26.10 01:00 МСК — по МСК уже следующая неделя.
    await svc.refillWeek(new Date('2026-10-25T22:00:00.000Z'));
    expect(inserted).toHaveLength(1);
    expect(inserted[0][4]).toBe('catalog:2026-W44:3');
  });

  it('ассистент без внятного профиля в каталог не ставится', async () => {
    const shortProfile = [...AGENTS, { id: 99, name: 'Тест', description: 'Юрист' }];
    const { svc, inserted } = refillSetup([
      ["status = 'idea' AND source = 'catalog'", { rows: [{ n: 2 }] }],
    ], shortProfile);
    await svc.refillWeek(new Date('2026-10-25T07:00:00.000Z'));
    expect(inserted.some((p) => p[8] === 99)).toBe(false);
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

  it('force: false, ближайший слот держит ролик в работе — срок подготовки считается от следующего свободного слота', async () => {
    const tx = routes([['SELECT slot_at FROM short_video', { rows: [{ slot_at: new Date(TUE) }] }]]);
    const v = await setup(tx).start({ force: false }, () => MON_EVENING);
    expect(v).toBeNull();
    expect(tx.seen.some((q) => q.sql.includes('UPDATE short_video'))).toBe(false);
    expect(tx.seen.some((q) => q.sql.startsWith('SELECT *'))).toBe(false);
  });

  it('start({ id }) с не-uuid — null без обращения к базе', async () => {
    const tx = routes();
    const v = await setup(tx).start({ id: 'not-a-uuid', force: true }, () => MON_EVENING);
    expect(v).toBeNull();
    expect(tx.seen).toHaveLength(0);
  });

  it('запрос занятых слотов перебирает и "directing", и "approved"', async () => {
    const tx = routes();
    await setup(tx).start({ force: false }, () => MON_EVENING);
    const assigned = tx.seen.find((q) => q.sql.includes('SELECT slot_at FROM short_video'));
    expect(assigned.params[0]).toEqual(expect.arrayContaining(['directing', 'approved']));
  });

  it('запрос последних роликов для ритма — без idea/rejected/failed, по slot_at DESC', async () => {
    const tx = routes();
    await setup(tx).start({ force: false }, () => MON_EVENING);
    const recent = tx.seen.find((q) => q.sql.includes('SELECT rubric, angle'));
    expect(recent.params[0]).toEqual(['idea', 'rejected', 'failed']);
    expect(recent.sql).toContain('ORDER BY slot_at DESC');
  });
});
