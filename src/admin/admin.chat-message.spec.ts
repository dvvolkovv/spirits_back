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

/// Гейт на живой аккаунт (ветка account-deletion): вставка БЕЗ проверки state
/// воскрешала строку истории удалённого поколения после core.purge. Образец —
/// chat.service.ts saveUserMessageRow/saveAssistantMessageRow (Task 11):
/// INSERT ... SELECT ... WHERE EXISTS (user_id.state = 'active') атомарно не
/// вставляет строку неактивному получателю; контроллер транслирует отказ в 400.
describe('сообщение ассистента: получатель удалённого поколения', () => {
  function makeGatedService(active: boolean) {
    const rows: Array<{ sql: string; params: any[] }> = [];
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        rows.push({ sql, params });
        if (/INSERT INTO custom_chat_history/i.test(sql)) {
          return active
            ? { rows: [{ id: 43, created_at: '2026-11-15T10:00:00Z' }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    return { svc: new AdminService(pg as any), rows };
  }

  it('state не active — явный отказ 4xx-семантики, строка не вставляется', async () => {
    const { svc, rows } = makeGatedService(false);

    await expect(svc.postAssistantMessage('79035281880', 12, 'текст'))
      .rejects.toThrow('recipient account is not active');

    // Единственный запрос — гейтовый INSERT, который ничего не вставил.
    expect(rows).toHaveLength(1);
    expect(rows[0].sql).toMatch(/WHERE EXISTS/);
    expect(rows[0].sql).toMatch(/state = 'active'/);
  });

  it('гейт атомарный: проверка живого аккаунта внутри INSERT, userId — последний параметр', async () => {
    const { svc, rows } = makeGatedService(true);

    await svc.postAssistantMessage('79035281880', 12, 'текст');

    const [{ sql, params }] = rows;
    expect(sql).toMatch(/INSERT INTO custom_chat_history[\s\S]*WHERE EXISTS \(SELECT 1 FROM user_id/);
    expect(params[params.length - 1]).toBe('79035281880');
    // Отдельного SELECT-препроверки нет: один запрос, гонка удаления не оставляет строку.
    expect(rows).toHaveLength(1);
  });

  it('active-получатель — вставка работает как раньше', async () => {
    const { svc } = makeGatedService(true);

    const out = await svc.postAssistantMessage('79035281880', 12, 'Переделал знак.');

    expect(out).toEqual(expect.objectContaining({ ok: true, id: 43 }));
  });
});
