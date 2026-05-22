const { TasksService } = require('../../dist/tasks/tasks.service');

function makePg(scripted) {
  let i = 0;
  return {
    query: jest.fn(async () => {
      const r = scripted[i++];
      if (!r) throw new Error('unexpected pg.query call');
      return r;
    }),
  };
}

describe('TasksService.setStatus', () => {
  test('обновляет статус и last_active_at для активного перевода', async () => {
    const pg = makePg([
      // UPDATE ... RETURNING
      { rows: [{ id: 't1', title: 'T', summary: 's', status: 'done', last_active_at: '2026-05-22' }] },
    ]);
    const svc = new TasksService(pg);
    const updated = await svc.setStatus('t1', '79030169187', 'done');

    expect(updated).toEqual({
      id: 't1', title: 'T', summary: 's', status: 'done', last_active_at: '2026-05-22',
    });
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE tasks/);
    expect(sql).toMatch(/SET status = \$1/);
    expect(sql).toMatch(/WHERE id = \$2 AND user_id = \$3/);
    expect(sql).toMatch(/RETURNING/);
    expect(params).toEqual(['done', 't1', '79030169187']);
  });

  test('возвращает null, если задача чужая', async () => {
    const pg = makePg([{ rows: [] }]);
    const svc = new TasksService(pg);
    const out = await svc.setStatus('t1', 'other-user', 'archived');
    expect(out).toBeNull();
  });

  test('кидает ошибку на невалидный статус', async () => {
    const pg = makePg([]);
    const svc = new TasksService(pg);
    await expect(svc.setStatus('t1', 'u', 'cancelled')).rejects.toThrow(/invalid status/);
    expect(pg.query).not.toHaveBeenCalled();
  });
});
