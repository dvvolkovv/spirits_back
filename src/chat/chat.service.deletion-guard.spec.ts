import { ChatService } from './chat.service';

/**
 * Task 11 — saveChatHistory после удаления аккаунта не создаёт строк.
 *
 * История удалённого аккаунта стирается немедленно; живой стрим, который
 * дописывает ответ уже после DELETE /webhook/profile, иначе воскрешал бы
 * строки custom_chat_history (и новые ссылки на файлы) для generation,
 * которой больше нет. Insert gated на user_id.state='active' через
 * INSERT ... SELECT ... WHERE EXISTS.
 */

function makeService() {
  const users = new Map<string, string>([['u-active', 'active'], ['u-deleted', 'deleted']]);
  const inserted: Array<{ sql: string; params: any[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/INSERT INTO custom_chat_history/.test(s)) {
        // Семантика прод-SQL: WHERE EXISTS (user_id state='active').
        // userId — последний параметр обеих вставок (после content/tokens).
        const userId = String(params[params.length - 1]);
        inserted.push({ sql: s, params });
        if (!/WHERE EXISTS/.test(s) || users.get(userId) !== 'active') {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const svc = new ChatService(
    pg as any, null as any,
    null as any, null as any, { resolveUserLanguage: async () => 'ru' } as any,
    undefined, undefined, undefined, undefined,
  );
  return { svc, pg, users, inserted, savedCount: () => inserted.filter((c) => c.sql.includes('WHERE EXISTS')).length };
}

describe('saveChatHistory — gate на активный аккаунт', () => {
  it('удалённый аккаунт: insert не создаёт строк (human и ai)', async () => {
    const h = makeService();

    await (h.svc as any).saveChatHistory('u-deleted', '12', 'вопрос', 'ответ', 7);

    const inserts = h.inserted.filter((c) => /INSERT INTO custom_chat_history/.test(c.sql));
    expect(inserts).toHaveLength(2);
    for (const ins of inserts) {
      // INSERT ... SELECT ... WHERE EXISTS(user_id state='active')
      expect(ins.sql).toMatch(/INSERT INTO custom_chat_history[\s\S]*SELECT/);
      expect(ins.sql).toMatch(/WHERE EXISTS \(SELECT 1 FROM user_id u WHERE u\.internal_id = \$\d+ AND u\.state = 'active'\)/);
      expect(ins.params[ins.params.length - 1]).toBe('u-deleted');
    }
  });

  it('активный аккаунт: строки сохраняются, content/tokens на прежних позициях', async () => {
    const h = makeService();
    const savedRows: any[] = [];
    h.pg.query.mockImplementation(async (sql: string, params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/INSERT INTO custom_chat_history/.test(s)) {
        const userId = String(params[params.length - 1]);
        if (/WHERE EXISTS/.test(s) && h.users.get(userId) === 'active') savedRows.push({ s, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await (h.svc as any).saveChatHistory('u-active', '12', 'вопрос', 'ответ', 7);

    expect(savedRows).toHaveLength(2);
    // Позиции параметров, на которые смотрят существующие спеки:
    // params[2] — content, params[3] — tokens_used (ai-строка).
    const ai = savedRows.find((r) => /'ai'/.test(r.s));
    expect(ai.params[2]).toBe('ответ');
    expect(ai.params[3]).toBe(7);
    const human = savedRows.find((r) => /'human'/.test(r.s));
    expect(human.params[2]).toBe('вопрос');
  });

  it('gate живёт в SQL, а не в JS: один query на строку, без предварительного SELECT состояния', async () => {
    const h = makeService();

    await (h.svc as any).saveChatHistory('u-active', '12', 'в', 'о', 0);

    const queries = h.pg.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(queries.filter((q) => /FROM user_id/.test(q) && !/INSERT/.test(q))).toHaveLength(0);
  });
});
