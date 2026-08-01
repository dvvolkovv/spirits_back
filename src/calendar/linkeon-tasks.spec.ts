import { LinkeonTasksService } from './linkeon-tasks.service';

// Мокаем PgService: роутим по SQL. Тестируем ЧИСТУЮ трансформацию строк БД → Task[] в list().
function makePg(taskRows: any[], occRows: any[] = []) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('linkeon_task_occurrences')) return { rows: occRows };
      if (sql.includes('FROM linkeon_tasks')) return { rows: taskRows };
      return { rows: [] };
    }),
  } as any;
}

describe('LinkeonTasksService.list — дела/рутины за окно', () => {
  const now = new Date('2026-08-01T09:00:00+05:00'); // сб, 9:00 Екб
  const to = new Date(now.getTime() + 7 * 24 * 3600_000);

  it('одноразовые: pending/просроченное висят, сделанное сегодня показано, вчерашнее — нет', async () => {
    const svc = new LinkeonTasksService(
      makePg([
        { uid: 'p1', title: 'Купить билеты', due: '2026-08-01T20:00:00+05:00', status: 'pending', recurrence: null },
        { uid: 'o1', title: 'Отчёт', due: '2026-07-31T15:00:00+05:00', status: 'pending', recurrence: null }, // вчера → просрочено
        { uid: 'd1', title: 'Позвонить', status: 'done', done_at: '2026-08-01T08:00:00+05:00', recurrence: null },
        { uid: 'd2', title: 'Старое', status: 'done', done_at: '2026-07-31T10:00:00+05:00', recurrence: null },
        { uid: 'some', title: 'Когда-нибудь', status: 'pending', recurrence: null }, // без due
      ]),
    );
    const out = await svc.list('u1', now, to, now);
    const byUid = Object.fromEntries(out.map((t) => [t.uid, t]));
    expect(byUid['p1']).toBeDefined();
    expect(byUid['o1']).toBeDefined(); // просроченное висит
    expect(byUid['d1']?.status).toBe('done'); // сделано сегодня — показано
    expect(byUid['d2']).toBeUndefined(); // сделано вчера — скрыто
    expect(byUid['some']).toBeDefined(); // без срока — показано
  });

  it('рутина: сегодняшнее вхождение (pending, isRoutine, occurrenceDate); поштучный статус', async () => {
    const svc = new LinkeonTasksService(
      makePg(
        [{ uid: 'r1', title: 'Умыться с гелем', due: '2026-08-01T06:00:00+05:00', status: 'pending', recurrence: { freq: 'daily' } }],
        [], // без отметок → сегодня pending
      ),
    );
    const out = await svc.list('u1', now, to, now);
    const today = out.find((t) => t.occurrenceDate === '2026-08-01');
    expect(today).toBeDefined();
    expect(today!.isRoutine).toBe(true);
    expect(today!.status).toBe('pending');
    // прошлые дни рутины не тащатся
    expect(out.some((t) => (t.occurrenceDate ?? '') < '2026-08-01')).toBe(false);
  });

  it('рутина: сегодня отмечена done → показана done; отмечена skipped → скрыта', async () => {
    const doneSvc = new LinkeonTasksService(
      makePg(
        [{ uid: 'r1', title: 'Зарядка', due: '2026-08-01T07:00:00+05:00', status: 'pending', recurrence: { freq: 'daily' } }],
        [{ task_uid: 'r1', occ: '2026-08-01', status: 'done', done_at: '2026-08-01T07:30:00+05:00', due_override: null }],
      ),
    );
    const out1 = await doneSvc.list('u1', now, to, now);
    expect(out1.find((t) => t.occurrenceDate === '2026-08-01')?.status).toBe('done');

    const skipSvc = new LinkeonTasksService(
      makePg(
        [{ uid: 'r2', title: 'Пропущу', due: '2026-08-01T07:00:00+05:00', status: 'pending', recurrence: { freq: 'daily' } }],
        [{ task_uid: 'r2', occ: '2026-08-01', status: 'skipped', done_at: null, due_override: null }],
      ),
    );
    const out2 = await skipSvc.list('u1', now, to, now);
    expect(out2.find((t) => t.occurrenceDate === '2026-08-01')).toBeUndefined();
  });
});
