import { AdminService } from './admin.service';

/// Сообщение ассистента в чат человека — тем же путём, каким туда попадают
/// ответы ассистентов и напоминания рутин: строка в `custom_chat_history`
/// с ключом сессии `<пользователь>_<ассистент>`.
///
/// Нужно, чтобы отдать переделанную работу туда, где человек её ждёт, и не
/// заставлять его ничего делать. Ошибка в ключе сессии = сообщение уедет в
/// чужой чат или в никуда, поэтому он тут и проверяется.

function makeService() {
  const rows: Array<{ sql: string; params: any[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      rows.push({ sql, params });
      return { rows: [{ id: 42, created_at: '2026-11-14T18:00:00Z' }], rowCount: 1 };
    }),
  };
  return { svc: new AdminService(pg as any), rows };
}

describe('сообщение ассистента в чат человека', () => {
  it('ложится в историю того же чата от лица ассистента', async () => {
    const { svc, rows } = makeService();

    const out = await svc.postAssistantMessage('79035281880', 12, 'Переделал знак, файлы ниже.');

    expect(out).toEqual(expect.objectContaining({ ok: true, id: 42 }));
    const [{ sql, params }] = rows;
    expect(sql).toContain('INSERT INTO custom_chat_history');
    expect(params[0]).toBe('79035281880_12');
    expect(params[1]).toBe(12);
    expect(params[2]).toBe('Переделал знак, файлы ниже.');
    expect(sql).toMatch(/'ai'/);
  });

  it('не списывает токены: это наша работа над ошибками', async () => {
    const { svc, rows } = makeService();

    await svc.postAssistantMessage('79035281880', 12, 'текст');

    expect(rows[0].sql).toMatch(/tokens_used/);
    expect(rows[0].sql).toMatch(/'text', 0/);
  });

  it.each([
    ['', 12, 'текст'],
    ['79035281880', 0, 'текст'],
    ['79035281880', 12, '   '],
  ])('не пишет при пустых данных (%p, %p, %p)', async (user, agent, text) => {
    const { svc, rows } = makeService();

    await expect(svc.postAssistantMessage(user as string, agent as number, text as string))
      .rejects.toThrow();

    expect(rows).toEqual([]);
  });
});
