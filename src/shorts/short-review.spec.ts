import { LEAVE_FROM, RELEASED_SQL, explainRefusal, leaveReview, noteForReview, versionClause } from './short-review';
import { canTransition, rowToShort } from './shorts.types';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const VERSION = '2026-10-30 12:34:56.123456+00';
const row = (over: Record<string, any> = {}) => ({
  id: ID, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', status: 'pending_review', ...over,
});

/** Пул-заглушка: UPDATE — заданным ответом, чтение причины — заданной строкой (или пусто). */
function fakePg(update: { rows: any[] }, after: any = null) {
  return {
    query: jest.fn(async (sql: string) => (sql.startsWith('UPDATE') ? update : { rows: after ? [after] : [] })),
  };
}

describe('versionClause', () => {
  it('без версии — ни условия, ни параметра', () => {
    const params: any[] = [ID];
    expect(versionClause(params, undefined)).toBe('');
    expect(versionClause(params, null)).toBe('');
    expect(params).toEqual([ID]);
  });

  it('с версией — условие на следующий номер параметра', () => {
    const params: any[] = [ID, 'x'];
    expect(versionClause(params, VERSION)).toBe(' AND updated_at = $3::timestamptz');
    expect(params).toEqual([ID, 'x', VERSION]);
  });
});

describe('leaveReview', () => {
  it('без версии — SQL и параметры кнопок лички: статус, откуда, «не вышел»', async () => {
    const pg = fakePg({ rows: [row({ status: 'directing' })] });
    const out = await leaveReview(pg as any, ID, 'directing');
    expect(out).toMatchObject({ ok: true, short: { id: ID, status: 'directing' } });
    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toContain('SET status = $2');
    expect(sql).toContain(`AND NOT ${RELEASED_SQL}`);
    expect(sql).not.toContain('updated_at = $');
    expect(params).toEqual([ID, 'directing', LEAVE_FROM]);
  });

  it('с версией — условие версии в самой записи', async () => {
    const pg = fakePg({ rows: [row({ status: 'rejected' })] });
    await leaveReview(pg as any, ID, 'rejected', VERSION);
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toContain('AND updated_at = $4::timestamptz');
    expect(params).toEqual([ID, 'rejected', LEAVE_FROM, VERSION]);
  });

  it('не записалось — причина чтением после: вышел, не тот статус, версия устарела, строки нет', async () => {
    const cases: [any, string, string | null][] = [
      [{ status: 'approved', released: true }, 'released', 'approved'],
      [{ status: 'writing', released: false }, 'status', 'writing'],
      [{ status: 'pending_review', released: false }, 'stale', 'pending_review'],
      [null, 'not_found', null],
    ];
    for (const [after, reason, status] of cases) {
      const pg = fakePg({ rows: [] }, after);
      expect(await leaveReview(pg as any, ID, 'rejected', VERSION)).toEqual({ ok: false, reason, status });
    }
  });
});

describe('noteForReview', () => {
  it('замечание дописано к прежним, ролик — к сценаристу; без версии параметры прежние', async () => {
    const pg = fakePg({ rows: [row({ status: 'writing' })] });
    const out = await noteForReview(pg as any, rowToShort(row({ owner_note: 'короче' })), 'без цифр');
    expect(out.ok).toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toContain("status = 'writing'");
    expect(sql).toContain("WHERE id = $1 AND status = 'pending_review'");
    expect(params).toEqual([ID, 'короче\nбез цифр']);
  });

  it('с версией — условие версии; не записалось — причина', async () => {
    const pg = fakePg({ rows: [] }, { status: 'pending_review', released: false });
    const out = await noteForReview(pg as any, rowToShort(row()), 'без цифр', VERSION);
    expect(out).toEqual({ ok: false, reason: 'stale', status: 'pending_review' });
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toContain('AND updated_at = $3::timestamptz');
    expect(params).toEqual([ID, 'без цифр', VERSION]);
  });

  it('ролик уже не ждёт решения — причина «статус», а не «версия»', async () => {
    const pg = fakePg({ rows: [] }, { status: 'approved', released: false });
    expect(await noteForReview(pg as any, rowToShort(row()), 'без цифр', VERSION))
      .toEqual({ ok: false, reason: 'status', status: 'approved' });
  });
});

describe('explainRefusal', () => {
  it('«вышел» важнее статуса', async () => {
    const pg = fakePg({ rows: [] }, { status: 'published', released: true });
    expect(await explainRefusal(pg as any, ID, ['pending_review'])).toEqual({ reason: 'released', status: 'published' });
  });
});

describe('LEAVE_FROM и таблица переходов', () => {
  it('«Переснять» и «Отклонить» разрешены из обоих статусов, замечание — из ждущего решения', () => {
    expect(LEAVE_FROM).toEqual(['pending_review', 'approved']);
    expect(LEAVE_FROM.every((s) => canTransition(s, 'directing') && canTransition(s, 'rejected'))).toBe(true);
    expect(canTransition('pending_review', 'writing')).toBe(true);
  });
});
