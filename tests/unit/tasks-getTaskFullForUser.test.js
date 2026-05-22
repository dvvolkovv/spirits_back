const { TasksService } = require('../../dist/tasks/tasks.service');

function makePg(scriptedResponses) {
  let i = 0;
  return {
    query: jest.fn(async () => {
      const r = scriptedResponses[i++];
      if (!r) throw new Error('pg.query called more times than scripted');
      return r;
    }),
  };
}

describe('TasksService.getTaskFullForUser', () => {
  test('возвращает task + events с agent_name; не возвращает claudemd', async () => {
    const pg = makePg([
      // ownership + task row
      { rows: [{ id: 't1', user_id: '79030169187', title: 'T', summary: 's', status: 'active', last_active_at: '2026-05-22' }] },
      // events with agent_name joined (note: DB returns oldest-first after reverse, so we set up DESC order here)
      { rows: [
        { id: 'e2', content: 'world', agent_id: null, agent_name: null,  created_at: '2026-05-22T11:00:00Z' },
        { id: 'e1', content: 'hello', agent_id: 5,    agent_name: 'Юля', created_at: '2026-05-22T10:00:00Z' },
      ]},
    ]);
    const svc = new TasksService(pg);
    const out = await svc.getTaskFullForUser('t1', '79030169187', 30);

    expect(out).not.toBeNull();
    expect(out.task).toEqual({
      id: 't1', title: 'T', summary: 's', status: 'active', last_active_at: '2026-05-22',
    });
    // Events should be reversed back to chronological order (oldest first):
    expect(out.events).toEqual([
      { id: 'e1', content: 'hello', agent_id: 5,    agent_name: 'Юля',  created_at: '2026-05-22T10:00:00Z' },
      { id: 'e2', content: 'world', agent_id: null, agent_name: null,    created_at: '2026-05-22T11:00:00Z' },
    ]);

    // SELECT не должен включать claudemd
    expect(pg.query.mock.calls[0][0]).not.toMatch(/claudemd/);
  });

  test('возвращает null, если задача принадлежит другому юзеру', async () => {
    const pg = makePg([{ rows: [] }]); // ownership check возвращает пусто
    const svc = new TasksService(pg);
    const out = await svc.getTaskFullForUser('t1', '79030169187');
    expect(out).toBeNull();
  });

  test('лимит событий ограничивается значением аргумента', async () => {
    const pg = makePg([
      { rows: [{ id: 't1', user_id: 'u', title: 'T', summary: '', status: 'active', last_active_at: null }] },
      { rows: [] },
    ]);
    const svc = new TasksService(pg);
    await svc.getTaskFullForUser('t1', 'u', 12);
    expect(pg.query.mock.calls[1][1]).toEqual(['t1', 12]);
  });
});
