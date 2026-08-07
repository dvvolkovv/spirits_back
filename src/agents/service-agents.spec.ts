import { AgentsService } from './agents.service';

/**
 * Служебные агенты не должны показываться на экране выбора ассистента.
 *
 * Строка `linkeon_voice` («Линкеон») существует в таблице agents только как
 * носитель system_prompt для голосового цикла лаунчера. `getAgents` отдаёт
 * таблицу целиком, поэтому без явного фильтра такая строка автоматически
 * становится карточкой ассистента у пользователя и строкой в настройках голосов.
 */
function makeService(rows: any[]) {
  const query = jest.fn(async () => ({ rows }));
  const svc = new AgentsService({ query } as any);
  return { svc, query };
}

describe('getAgents — служебные агенты скрыты', () => {
  it('передаёт список служебных имён параметром запроса', async () => {
    const { svc, query } = makeService([]);
    await svc.getAgents('ru');

    const [, params] = query.mock.calls[0] as any[];
    expect(params[1]).toContain('linkeon_voice');
  });

  it('запрос действительно фильтрует по имени, а не просто получает список', async () => {
    const { svc, query } = makeService([]);
    await svc.getAgents('ru');

    const [sql] = query.mock.calls[0] as any[];
    expect(sql).toMatch(/WHERE\s+a\.name\s+<>\s+ALL/i);
  });

  it('не режет обычных ассистентов', async () => {
    const rows = [
      { id: 12, name: 'Роман', displayName: 'Роман' },
      { id: 2, name: 'Оля', displayName: 'Оля' },
    ];
    const { svc } = makeService(rows);
    const out = await svc.getAgents('ru');

    expect(out.map((a: any) => a.name)).toEqual(['Роман', 'Оля']);
  });
});
