import { BacklogService } from './backlog.service';

/**
 * Задача из тикета. Заголовок задачи уходит в снимок ВПМ и маркетолога, а
 * снимок — в промпт модели, поэтому в нём не должно быть user_id: у
 * пользователей с телефоном это номер. Номер ниже выдуманный.
 */
describe('createFromTicket(): без user_id в заголовке и в запросе к модели', () => {
  const USER_ID = '79990001122';
  const TICKET_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

  function makeService(topic: string | null, claudeText: () => Promise<{ text: string }>) {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const pg: any = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        if (/FROM support_tickets/.test(sql)) return { rows: [{ id: TICKET_ID, user_id: USER_ID, topic }] };
        if (/FROM support_messages/.test(sql)) {
          return { rows: [{ sender_type: 'user', content: 'Не открывается раздел оплаты', created_at: '2026-11-03' }] };
        }
        if (/INSERT INTO backlog_items/.test(sql)) return { rows: [{ id: 'b-1', title: params[0] }] };
        return { rows: [] };
      }),
    };
    const claude: any = { textWithCost: jest.fn(claudeText) };
    const svc = new BacklogService(pg, claude);
    const insert = () => queries.find((q) => /INSERT INTO backlog_items/.test(q.sql))!;
    return { svc, claude, insert };
  }

  it('сводка не получилась, темы нет — заголовок по тикету, без user_id', async () => {
    const { svc, insert } = makeService(null, async () => {
      throw new Error('timeout');
    });
    await svc.createFromTicket('admin-1', TICKET_ID);

    const title = insert().params[0];
    expect(title).toBe('Запрос из тикета a1b2c3d4');
    expect(title).not.toContain(USER_ID);
  });

  it('сводка не получилась, тема есть — заголовок из темы', async () => {
    const { svc, insert } = makeService('Оплата картой', async () => ({ text: 'не json' }));
    await svc.createFromTicket('admin-1', TICKET_ID);

    expect(insert().params[0]).toBe('Оплата картой');
  });

  it('в запросе к модели нет user_id', async () => {
    const { svc, claude } = makeService(null, async () => ({
      text: '{"title":"Оплата картой","analysis_md":"## Запрос пользователя","complexity":"low"}',
    }));
    await svc.createFromTicket('admin-1', TICKET_ID);

    expect(claude.textWithCost).toHaveBeenCalledTimes(1);
    expect(claude.textWithCost.mock.calls[0][0]).not.toContain(USER_ID);
  });
});
