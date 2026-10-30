import { ActionPlansService, parseGeneratedActionPlan } from './action-plans.service';

describe('parseGeneratedActionPlan', () => {
  it('reads JSON from a fenced model response', () => {
    expect(parseGeneratedActionPlan('```json\n{"title":"Переезд","summary":"Подготовиться спокойно","items":["Составить список вещей","Забронировать транспорт"]}\n```')).toEqual({
      title: 'Переезд',
      summary: 'Подготовиться спокойно',
      items: ['Составить список вещей', 'Забронировать транспорт'],
    });
  });

  it('rejects a response without actionable items', () => {
    expect(() => parseGeneratedActionPlan('{"title":"План","items":[]}')).toThrow('incomplete');
    expect(() => parseGeneratedActionPlan('not json')).toThrow('not JSON');
  });
});

describe('ActionPlansService', () => {
  const row = {
    id: 'plan-1', assistant_id: '12', title: 'Новый план', summary: 'Кратко',
    items: [], created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:00:00Z',
  };

  function setup(raw = '{"title":"Новый план","summary":"Кратко","items":["Первый шаг","Второй шаг"]}') {
    const pg = { query: jest.fn() };
    const chat = {
      getChatHistory: jest.fn().mockResolvedValue({ messages: [
        { type: 'user', content: 'Нужно подготовиться к переезду' },
        { type: 'assistant', content: 'Начни со списка вещей' },
      ] }),
      generateAgentReply: jest.fn().mockResolvedValue(raw),
    };
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM action_plans')) return { rows: [] };
      return { rows: [row] };
    });
    return { service: new ActionPlansService(pg as any, chat as any), pg, chat };
  }

  it('generates in an isolated session without writing to chat history', async () => {
    const { service, chat, pg } = setup();
    await service.generate('user-1', '12');
    expect(chat.generateAgentReply).toHaveBeenCalledWith(
      'user-1', '12', expect.stringContaining('Return ONLY valid JSON'), expect.stringMatching(/^action_plan_/),
    );
    expect(pg.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (user_id, session_id)'), expect.any(Array));
  });

  it('uses the fresh-start history and storage session', async () => {
    const { service, chat, pg } = setup();
    await service.generate('user-1', '12', '123456789');
    expect(chat.getChatHistory).toHaveBeenCalledWith('user-1', '12', 30, 0, 'user-1_12_fresh_123456789');
    const insert = pg.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO action_plans'));
    expect(insert?.[1][1]).toBe('user-1_12_fresh_123456789');
  });

  it('keeps completion for unchanged steps when regenerating', async () => {
    const { service, pg } = setup();
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM action_plans')) return { rows: [{ ...row, items: [{ id: 'old', text: 'Первый шаг', done: true }] }] };
      return { rows: [row] };
    });
    await service.generate('user-1', '12');
    const insert = pg.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO action_plans'));
    const items = JSON.parse(insert?.[1][5]);
    expect(items[0].done).toBe(true);
    expect(items[1].done).toBe(false);
  });

  it('scopes edits and deletion to the plan owner', async () => {
    const { service, pg } = setup();
    pg.query.mockResolvedValue({ rows: [row] });
    await service.update('user-1', 'plan-1', { title: 'План', summary: '', items: [{ id: 'one', text: 'Шаг', done: false }] });
    expect(pg.query.mock.calls[0][1].slice(-2)).toEqual(['plan-1', 'user-1']);
    await service.remove('user-1', 'plan-1');
    expect(pg.query.mock.calls[1][1]).toEqual(['plan-1', 'user-1']);
  });
});
