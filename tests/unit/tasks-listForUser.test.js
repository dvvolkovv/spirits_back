const { TasksService } = require('../../dist/tasks/tasks.service');

// Stub PgService: возвращает преданные rows из последнего query.
function makePg(rows) {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  };
}

describe('TasksService.listForUser', () => {
  test('возвращает поля для user UI (без claudemd) и сортирует active первыми', async () => {
    const pg = makePg([
      { id: 't1', title: 'Active', status: 'active',   summary: 's1', last_active_at: '2026-05-20' },
      { id: 't2', title: 'Done',   status: 'done',     summary: 's2', last_active_at: '2026-05-22' },
      { id: 't3', title: 'Arch',   status: 'archived', summary: 's3', last_active_at: '2026-05-21' },
    ]);
    const svc = new TasksService(pg);
    const rows = await svc.listForUser('79030169187');

    expect(pg.query).toHaveBeenCalledTimes(1);
    const sql = pg.query.mock.calls[0][0];
    expect(sql).toMatch(/FROM tasks/);
    expect(sql).toMatch(/WHERE user_id = \$1/);
    expect(sql).not.toMatch(/claudemd/); // не должен возвращать claudemd
    expect(rows).toEqual([
      { id: 't1', title: 'Active', status: 'active',   summary: 's1', last_active_at: '2026-05-20' },
      { id: 't2', title: 'Done',   status: 'done',     summary: 's2', last_active_at: '2026-05-22' },
      { id: 't3', title: 'Arch',   status: 'archived', summary: 's3', last_active_at: '2026-05-21' },
    ]);
  });

  test('возвращает пустой массив, если pg не сконфигурирован', async () => {
    const svc = new TasksService(undefined);
    expect(await svc.listForUser('user')).toEqual([]);
  });
});
