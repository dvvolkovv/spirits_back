import { BlogController } from './blog.controller';
import { BadRequestException, ConflictException } from '@nestjs/common';

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const rawRow = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', source_ref: null, topic_key: 'k', topic_hint: null,
  lang: 'ru', title: 'З', body: 'Т', image_prompt: 'сцена', image_url: 'u',
  status: 'pending_review', slot_at: null, published_at: null, review_chat_id: null, review_message_id: null,
  tg_message_id: null, tg_url: null, attempts: 0, last_error: null,
  created_at: '2026-09-21T10:00:00.000Z', updated_at: '2026-09-21T10:00:00.000Z', ...over,
});

const deps = () => ({
  pg: { query: jest.fn().mockResolvedValue({ rows: [rawRow()] }) },
  topics: { addTopic: jest.fn().mockResolvedValue({ id: 'new' }) },
  settings: { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }), update: jest.fn().mockResolvedValue({}) },
  images: { render: jest.fn().mockResolvedValue('https://minio/new.png') },
});

const make = (d: any) => new BlogController(d.pg, d.topics, d.settings, d.images);

describe('BlogController', () => {
  it('list отдаёт очередь', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'list' }, r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  // Сорвавшаяся публикация требует внимания — ей место в очереди. Если failed
  // попадёт в обе выборки, вкладка покажет один и тот же пост дважды.
  it('failed виден в очереди и не двоится в архиве', async () => {
    const d = deps(); const r = res();
    const c = make(d);
    await c.action({ action: 'list' }, r);
    await c.action({ action: 'archive' }, r);
    const [listSql, archiveSql] = d.pg.query.mock.calls.map((x: any[]) => String(x[0]));
    expect(listSql).not.toContain('failed');
    expect(archiveSql).not.toContain('failed');
  });

  it('add_topic заводит ручную тему с источником manual', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'add_topic', rubric: 'case', topic: 'про аренду' }, r);
    expect(d.topics.addTopic).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual' }));
  });

  it('update_text с верной версией сохраняет текст', async () => {
    const d = deps(); const r = res();
    await make(d).action({
      action: 'update_text', id: 'p1', title: 'Новый', body: 'Новое',
      updatedAt: '2026-09-21T10:00:00.000Z',
    }, r);
    expect(d.pg.query.mock.calls[1][0]).toContain('UPDATE blog_post');
  });

  it('update_text с устаревшей версией отдаёт 409, а не затирает чужую правку', async () => {
    const d = deps(); const r = res();
    await expect(make(d).action({
      action: 'update_text', id: 'p1', title: 'Новый', body: 'Новое',
      updatedAt: '2026-09-21T09:00:00.000Z',
    }, r)).rejects.toBeInstanceOf(ConflictException);
  });

  it('approve назначает слот', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'approve', id: 'p1' }, r);
    // Запись ищем по содержанию, а не по номеру вызова: перед ней теперь идёт
    // чтение занятых слотов.
    const write = d.pg.query.mock.calls.map((c: any[]) => String(c[0])).find((s: string) => /^\s*UPDATE blog_post/.test(s));
    expect(write).toContain("status = 'approved'");
  });

  /**
   * Панелей управления постом две, и вторая не должна уметь меньше первой:
   * «в мусор» из админки — тот же терминальный статус, что и кнопка в личке.
   */
  it('reject из админки стирает замечания, как и кнопка «в мусор» в личке', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'reject', id: 'p1' }, r);
    expect(String(d.pg.query.mock.calls[1][0])).toContain("editor_notes = '{}'");
  });

  /** redraft — переработка, а не финал: замечания редактору ещё нужны. */
  it('redraft из админки замечания сохраняет', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'redraft', id: 'p1' }, r);
    expect(String(d.pg.query.mock.calls[1][0])).not.toContain('editor_notes');
  });

  /**
   * Вторая панель отправляет на переработку ровно так же, как первая: пустая
   * отметка означает «готов к работе прямо сейчас». Без этого пост из админки
   * ждал бы протухания порога, а из личка — нет.
   */
  it('redraft из админки освобождает пост под захват', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'redraft', id: 'p1' }, r);
    expect(String(d.pg.query.mock.calls[1][0])).toMatch(/drafting_started_at = NULL/i);
  });

  it('неизвестное действие — 400', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'взорви_всё' }, r);
    expect(r.status).toHaveBeenCalledWith(400);
  });

  // --- машина состояний: админка не должна уметь то, чего не умеют кнопки в личке ---

  it('redraft опубликованного поста отклоняется и не пишет статус', async () => {
    const d = deps(); const r = res();
    d.pg.query = jest.fn().mockResolvedValue({ rows: [rawRow({ status: 'published' })] });
    await expect(make(d).action({ action: 'redraft', id: 'p1' }, r))
      .rejects.toBeInstanceOf(ConflictException);
    expect(d.pg.query.mock.calls.some((c: any[]) => /UPDATE blog_post/.test(c[0]))).toBe(false);
  });

  it('approve отклонённого поста отклоняется — мусор не уезжает в канал', async () => {
    const d = deps(); const r = res();
    d.pg.query = jest.fn().mockResolvedValue({ rows: [rawRow({ status: 'rejected' })] });
    await expect(make(d).action({ action: 'approve', id: 'p1' }, r))
      .rejects.toBeInstanceOf(ConflictException);
    expect(d.pg.query.mock.calls.some((c: any[]) => /UPDATE blog_post/.test(c[0]))).toBe(false);
  });

  it('reject опубликованного поста отклоняется — из канала он уже не исчезнет', async () => {
    const d = deps(); const r = res();
    d.pg.query = jest.fn().mockResolvedValue({ rows: [rawRow({ status: 'published' })] });
    await expect(make(d).action({ action: 'reject', id: 'p1' }, r))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('статус, уехавший между чтением и записью, не переписывается молча', async () => {
    const d = deps(); const r = res();
    // Чтение поста, затем всё остальное (занятые слоты — пусто, запись — ноль строк).
    d.pg.query = jest.fn()
      .mockResolvedValueOnce({ rows: [rawRow()] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(make(d).action({ action: 'approve', id: 'p1' }, r))
      .rejects.toBeInstanceOf(ConflictException);
  });

  // --- версия: сравнение по моменту времени, а не по написанию строки ---

  it('та же метка времени в другом написании не даёт ложный 409', async () => {
    const d = deps(); const r = res();
    await make(d).action({
      action: 'update_text', id: 'p1', title: 'Новый', body: 'Новое',
      updatedAt: '2026-09-21T10:00:00Z',
    }, r);
    expect(d.pg.query.mock.calls[1][0]).toContain('UPDATE blog_post');
  });

  it('add_topic с пустой темой — 400, а не идея с пустым ключом', async () => {
    const d = deps(); const r = res();
    await expect(make(d).action({ action: 'add_topic', rubric: 'case', topic: '   ' }, r))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(d.topics.addTopic).not.toHaveBeenCalled();
  });
});

/**
 * Слоты в админке: одобрение в ближайший свободный слот, список ближайших
 * слотов с занятостью (`free_slots`) и перенос одобренного поста
 * (`reschedule`).
 *
 * Формы ответов `free_slots` и `reschedule` — контракт с фронтовой вкладкой,
 * зафиксированный заранее: фронт различает «слот занят» и «пост изменился» по
 * полю `error`, поэтому здесь сверяется тело ответа целиком, а не только код.
 */
describe('BlogController — слоты', () => {
  afterEach(() => { jest.useRealTimers(); });

  // вт 2026-09-22, 15:00 МСК: ближайший слот — ср 10:00 МСК
  const TUE = '2026-09-22T12:00:00Z';
  const WED = '2026-09-23T07:00:00.000Z';
  const FRI = '2026-09-25T07:00:00.000Z';
  const MON = '2026-09-28T07:00:00.000Z';

  const iso = (v: any) => (v ? new Date(v).toISOString() : null);

  /**
   * Postgres в миниатюре: посты и частичный уникальный индекс на `slot_at`
   * среди `approved`/`publishing` (004_one_post_per_slot.sql). Индекс здесь
   * играет роль базы: код обязан сам не лезть в занятый слот, а индекс —
   * последний рубеж на гонку. Условия на статус в записях заглушка берёт из
   * самого запроса. Незнакомый запрос — ошибка.
   */
  const ctrlPg = (posts: any[]) => {
    const rows: any[] = posts.map((p) => rawRow(p));
    let gate: { pattern: RegExp; n: number; parked: Array<() => void> } | null = null;
    const passGate = async (s: string) => {
      const g = gate;
      if (!g || !g.pattern.test(s)) return;
      await new Promise<void>((resolve) => {
        g.parked.push(resolve);
        if (g.parked.length >= g.n) {
          gate = null;
          g.parked.forEach((go) => go());
        }
      });
    };
    const hooks: { beforeWrite?: () => void } = {};
    const holding = (x: any) => ['approved', 'publishing'].includes(x.status);
    const clash = (r: any, slot: any) => rows.find((x) => x !== r && holding(x) && iso(x.slot_at) === iso(slot));
    const duplicate = () => Object.assign(
      new Error('duplicate key value violates unique constraint "uq_blog_post_slot"'),
      { code: '23505', constraint: 'uq_blog_post_slot' },
    );
    const holderRow = (x: any) => ({ id: x.id, title: x.title, slot_at: new Date(x.slot_at) });

    const query = jest.fn(async (sql: string, params: any[] = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      await passGate(s);

      if (/^SELECT \* FROM blog_post WHERE id = \$1$/.test(s)) {
        const r = rows.find((x) => x.id === params[0]);
        return { rows: r ? [{ ...r }] : [] };
      }

      if (/^SELECT id, title, slot_at FROM blog_post WHERE status = ANY\(\$1::text\[\]\) AND slot_at > \$2\b/.test(s)) {
        const after = new Date(params[1]).getTime();
        return {
          rows: rows.filter((x) => params[0].includes(x.status) && x.slot_at && new Date(x.slot_at).getTime() > after)
            .map(holderRow),
        };
      }

      if (/^SELECT id, title, slot_at FROM blog_post WHERE status = ANY\(\$1::text\[\]\) AND slot_at = \$2\b/.test(s)) {
        return { rows: rows.filter((x) => params[0].includes(x.status) && iso(x.slot_at) === iso(params[1])).map(holderRow) };
      }

      if (/^UPDATE blog_post SET status = 'approved', slot_at = \$2\b/.test(s)) {
        const r = rows.find((x) => x.id === params[0]);
        if (!r || (/\bAND status = \$3\b/.test(s) && r.status !== params[2])) return { rows: [], rowCount: 0 };
        if (clash(r, params[1])) throw duplicate();
        Object.assign(r, { status: 'approved', slot_at: new Date(params[1]), updated_at: new Date().toISOString() });
        return { rows: [], rowCount: 1 };
      }

      if (/^UPDATE blog_post SET slot_at = \$2\b/.test(s)) {
        hooks.beforeWrite?.();
        const r = rows.find((x) => x.id === params[0]);
        if (!r || (/\bAND status = 'approved'/.test(s) && r.status !== 'approved')) return { rows: [], rowCount: 0 };
        if (clash(r, params[1])) throw duplicate();
        Object.assign(r, { slot_at: new Date(params[1]), updated_at: new Date().toISOString() });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`заглушка не знает запроса: ${s}`);
    });

    return {
      rows, query, hooks,
      row: (id: string) => rows.find((x) => x.id === id),
      hold: (pattern: RegExp, n: number) => { gate = { pattern, n, parked: [] }; },
    };
  };

  const setup = (posts: any[], now = TUE) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.setSystemTime(new Date(now));
    const d = deps();
    const pg = ctrlPg(posts);
    d.pg = pg as any;
    const c = make(d);
    const call = async (body: any) => {
      const r = res();
      await c.action(body, r);
      return { status: r.status.mock.calls[0]?.[0], body: r.json.mock.calls[0]?.[0] };
    };
    /** Тело и код отказа — ровно то, что уйдёт фронту. */
    const refusal = async (body: any) => {
      try {
        await c.action(body, res());
      } catch (e: any) {
        return { status: e.getStatus?.(), body: e.getResponse?.() };
      }
      throw new Error('ожидали отказ, а действие прошло');
    };
    return { pg, call, refusal };
  };

  describe('approve', () => {
    it('без slotAt — ближайший свободный слот, а не занятый', async () => {
      const { pg, call } = setup([
        { id: 'case', status: 'approved', title: 'Кейс', slot_at: new Date(WED) },
        { id: 'news', status: 'pending_review' },
      ]);

      const { status, body } = await call({ action: 'approve', id: 'news' });

      expect(status).toBe(200);
      expect(iso(pg.row('news').slot_at)).toBe(FRI);
      expect(iso(body.slotAt)).toBe(FRI);
      expect(iso(pg.row('case').slot_at)).toBe(WED);
    });

    it('с явным slotAt на занятый слот — 409 slot_taken, заголовок занявшего назван', async () => {
      const { pg, refusal } = setup([
        { id: 'case', status: 'approved', title: 'Кейс про аренду', slot_at: new Date(WED) },
        { id: 'news', status: 'pending_review' },
      ]);

      const { status, body } = await refusal({ action: 'approve', id: 'news', slotAt: WED });

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'slot_taken' });
      expect(body.message).toContain('«Кейс про аренду»');
      expect(pg.row('news').status).toBe('pending_review');
    });

    it('гонка двух одобрений — проигравший встаёт в следующий свободный слот', async () => {
      const { pg, call } = setup([
        { id: 'p1', status: 'pending_review' },
        { id: 'p2', status: 'pending_review' },
      ]);
      pg.hold(/^SELECT id, title, slot_at FROM blog_post/, 2);

      const [a, b] = await Promise.all([call({ action: 'approve', id: 'p1' }), call({ action: 'approve', id: 'p2' })]);

      expect([a.status, b.status]).toEqual([200, 200]);
      expect([iso(pg.row('p1').slot_at), iso(pg.row('p2').slot_at)].sort()).toEqual([WED, FRI]);
    });
  });

  describe('free_slots', () => {
    const board = () => [
      { id: 'a1', status: 'approved', title: 'Кейс', slot_at: new Date(WED) },
      { id: 'a2', status: 'publishing', title: 'Уходит в канал', slot_at: new Date(MON) },
      // Отклонённый и опубликованный посты свои слоты не держат.
      { id: 'r1', status: 'rejected', title: 'В мусоре', slot_at: new Date(FRI) },
    ];

    it('ближайшие 6 слотов расписания, у занятых — пост', async () => {
      const { call } = setup(board());

      const { status, body } = await call({ action: 'free_slots' });

      expect(status).toBe(200);
      expect(body).toEqual([
        { slotAt: WED, takenBy: { id: 'a1', title: 'Кейс' } },
        { slotAt: FRI, takenBy: null },
        { slotAt: MON, takenBy: { id: 'a2', title: 'Уходит в канал' } },
        { slotAt: '2026-09-30T07:00:00.000Z', takenBy: null },
        { slotAt: '2026-10-02T07:00:00.000Z', takenBy: null },
        { slotAt: '2026-10-05T07:00:00.000Z', takenBy: null },
      ]);
    });

    it('count уважается, но не больше 20', async () => {
      const { call } = setup(board());
      expect((await call({ action: 'free_slots', count: 3 })).body).toHaveLength(3);
      expect((await call({ action: 'free_slots', count: 100 })).body).toHaveLength(20);
    });
  });

  describe('reschedule', () => {
    const board = () => [
      { id: 'case', status: 'approved', title: 'Кейс', slot_at: new Date(WED), updated_at: '2026-09-22T10:00:00.000Z' },
      { id: 'launch', status: 'approved', title: 'Новость о запуске', slot_at: new Date(MON) },
      { id: 'draft', status: 'pending_review', title: 'Черновик' },
    ];

    it('переносит одобренный пост и отдаёт его целиком', async () => {
      const { pg, call } = setup(board());

      const { status, body } = await call({ action: 'reschedule', id: 'case', slotAt: FRI });

      expect(status).toBe(200);
      expect(body).toMatchObject({ id: 'case', status: 'approved' });
      expect(iso(body.slotAt)).toBe(FRI);
      expect(iso(pg.row('case').slot_at)).toBe(FRI);
    });

    it('меняет только slot_at: статус не пишется, машина состояний не при чём', async () => {
      const { pg, call } = setup(board());

      await call({ action: 'reschedule', id: 'case', slotAt: FRI });

      const writes = pg.query.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' ')).filter((s: string) => /^\s*UPDATE/.test(s));
      expect(writes).toHaveLength(1);
      expect(writes[0].split(' WHERE ')[0]).not.toMatch(/\bstatus\b/);
      expect(writes[0]).toMatch(/updated_at = now\(\)/);
    });

    it('произвольное время, не по расписанию, допустимо', async () => {
      const { pg, call } = setup(board());

      const { status } = await call({ action: 'reschedule', id: 'case', slotAt: '2026-09-24T12:34:00.000Z' });

      expect(status).toBe(200);
      expect(iso(pg.row('case').slot_at)).toBe('2026-09-24T12:34:00.000Z');
    });

    it('на тот же слот — не конфликт с самим собой', async () => {
      const { call } = setup(board());
      expect((await call({ action: 'reschedule', id: 'case', slotAt: WED })).status).toBe(200);
    });

    it('на занятый слот — 409 slot_taken, message называет заголовок занявшего', async () => {
      const { pg, refusal } = setup(board());

      const { status, body } = await refusal({ action: 'reschedule', id: 'case', slotAt: MON });

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'slot_taken' });
      expect(body.message).toContain('«Новость о запуске»');
      expect(iso(pg.row('case').slot_at)).toBe(WED);
    });

    /**
     * Проверка «свободно» перед записью ничего не гарантирует: два переноса в
     * один слот прочли его свободным раньше, чем любой записал. Индекс пускает
     * одного, второму — тот же 409 slot_taken, а не 500 из необработанного 23505.
     */
    it('гонка двух переносов в один слот — второму 409 slot_taken, а не 500', async () => {
      const { pg, call } = setup(board());
      pg.hold(/^SELECT id, title, slot_at FROM blog_post WHERE status = ANY\(\$1::text\[\]\) AND slot_at = /, 2);

      const outcome = (p: Promise<any>) => p.then(
        (ok) => ({ status: ok.status, body: ok.body }),
        (e) => ({ status: e.getStatus?.() ?? 500, body: e.getResponse?.() ?? String(e) }),
      );
      const results = await Promise.all([
        outcome(call({ action: 'reschedule', id: 'case', slotAt: FRI })),
        outcome(call({ action: 'reschedule', id: 'launch', slotAt: FRI })),
      ]);

      const won = results.filter((x) => x.status === 200);
      const lost = results.filter((x) => x.status !== 200);
      expect(won).toHaveLength(1);
      expect(lost).toEqual([{ status: 409, body: expect.objectContaining({ error: 'slot_taken' }) }]);
      // Отказ называет того, кто слот забрал.
      const winner = pg.rows.find((x) => iso(x.slot_at) === FRI && x.status === 'approved');
      expect(lost[0].body.message).toContain(`«${winner.title}»`);
    });

    it('устаревший updatedAt — 409 version_conflict', async () => {
      const { pg, refusal } = setup(board());

      const { status, body } = await refusal({
        action: 'reschedule', id: 'case', slotAt: FRI, updatedAt: '2026-09-22T09:00:00.000Z',
      });

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'version_conflict' });
      expect(typeof body.message).toBe('string');
      expect(iso(pg.row('case').slot_at)).toBe(WED);
    });

    it('верный updatedAt в другом написании — не конфликт', async () => {
      const { call } = setup(board());
      const { status } = await call({ action: 'reschedule', id: 'case', slotAt: FRI, updatedAt: '2026-09-22T13:00:00+03:00' });
      expect(status).toBe(200);
    });

    it('пост ушёл из approved между чтением и записью — 409 version_conflict, слот не тронут', async () => {
      const { pg, refusal } = setup(board());
      pg.hooks.beforeWrite = () => { pg.row('case').status = 'publishing'; };

      const { status, body } = await refusal({ action: 'reschedule', id: 'case', slotAt: FRI });

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'version_conflict' });
      expect(iso(pg.row('case').slot_at)).toBe(WED);
    });

    it.each([
      ['пост не одобрен', { id: 'draft', slotAt: FRI }],
      ['slotAt в прошлом', { id: 'case', slotAt: '2026-09-21T07:00:00.000Z' }],
      ['slotAt не разбирается', { id: 'case', slotAt: 'в пятницу' }],
      ['slotAt не передан', { id: 'case' }],
    ])('%s — 400 bad_request', async (_why, payload) => {
      const { pg, refusal } = setup(board());

      const { status, body } = await refusal({ action: 'reschedule', ...payload });

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'bad_request' });
      expect(typeof body.message).toBe('string');
      expect(pg.query.mock.calls.some((c: any[]) => /^\s*UPDATE/.test(String(c[0])))).toBe(false);
    });
  });
});
