import { AdminService } from './admin.service';

/**
 * Очередь модерации.
 *
 * Проверяется то, ради чего она заведена: жалоба должна перестать быть
 * записью в никуда. До этого во всём бэкенде был один INSERT в user_reports
 * и ни одного чтения, при том что оферта обещает рассмотреть жалобу за
 * 24 часа.
 */

interface Recorded {
  sql: string;
  params: any[];
}

/** Подставной pg: запоминает запросы и отдаёт заготовленные ответы. */
function fakePg(rows: Record<string, any[]> = {}) {
  const calls: Recorded[] = [];
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      for (const [needle, value] of Object.entries(rows)) {
        if (sql.includes(needle)) return { rows: value };
      }
      return { rows: [] };
    },
  };
}

function serviceWith(pg: any): AdminService {
  return new AdminService(pg as any);
}

describe('AdminService — очередь жалоб', () => {
  describe('listReports', () => {
    it('по умолчанию отдаёт только неразобранные', async () => {
      const pg = fakePg();
      await serviceWith(pg).listReports();

      expect(pg.calls[0].sql).toContain("r.status = 'new'");
      expect(pg.calls[0].sql).not.toContain('WHERE true');
    });

    it('status=all снимает фильтр', async () => {
      const pg = fakePg();
      await serviceWith(pg).listReports({ status: 'all' });

      expect(pg.calls[0].sql).toContain('WHERE true');
    });

    // Модератору нужно решение принимать здесь, не уходя искать переписку
    // руками по номеру телефона.
    it('подтягивает имена сторон и текст сообщения из контекста', async () => {
      const pg = fakePg();
      await serviceWith(pg).listReports();

      const sql = pg.calls[0].sql;
      expect(sql).toContain('peer_messages');
      expect(sql).toContain('reporter.profile_data');
      expect(sql).toContain('target.profile_data');
    });

    it('считает возраст жалобы в часах', async () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const pg = fakePg({
        'FROM user_reports r': [
          {
            id: 'r1',
            reporter_id: '70000000001',
            target_id: '70000000002',
            reason: 'спам',
            status: 'new',
            created_at: threeHoursAgo,
            target_state: 'active',
          },
        ],
      });

      const [item] = await serviceWith(pg).listReports();
      expect(item.ageHours).toBe(3);
      expect(item.targetBlocked).toBe(false);
    });

    it('видит, что нарушитель уже заблокирован', async () => {
      const pg = fakePg({
        'FROM user_reports r': [
          {
            id: 'r1',
            reporter_id: '1',
            target_id: '2',
            reason: 'x',
            status: 'new',
            created_at: new Date().toISOString(),
            target_state: 'blocked',
          },
        ],
      });

      const [item] = await serviceWith(pg).listReports();
      expect(item.targetBlocked).toBe(true);
    });
  });

  describe('resolveReport', () => {
    it('несуществующая жалоба — not_found, без изменений в базе', async () => {
      const pg = fakePg();
      const r = await serviceWith(pg).resolveReport('нет-такой', {
        action: 'dismiss',
        moderator: 'admin',
      });

      expect(r).toEqual({ ok: false, reason: 'not_found' });
      expect(pg.calls.some((c) => c.sql.includes('UPDATE'))).toBe(false);
    });

    // Ключевое: блокировка должна переводить аккаунт в то же состояние,
    // которое проверяется при входе (auth.service.ts), иначе человек
    // помечен, но продолжает пользоваться сервисом.
    it('block закрывает вход нарушителю', async () => {
      const pg = fakePg({
        'SELECT target_id': [{ target_id: '70000000002', status: 'new' }],
      });

      const r = await serviceWith(pg).resolveReport('r1', {
        action: 'block',
        moderator: 'admin',
      });

      expect(r.ok).toBe(true);
      const ban = pg.calls.find((c) => c.sql.includes('UPDATE user_id'));
      expect(ban).toBeDefined();
      expect(ban!.sql).toContain("state = 'blocked'");
      expect(ban!.params).toContain('70000000002');
    });

    it('dismiss не трогает аккаунт', async () => {
      const pg = fakePg({
        'SELECT target_id': [{ target_id: '70000000002', status: 'new' }],
      });

      await serviceWith(pg).resolveReport('r1', { action: 'dismiss', moderator: 'admin' });

      expect(pg.calls.some((c) => c.sql.includes('UPDATE user_id'))).toBe(false);
    });

    it('content_removed тоже не блокирует человека', async () => {
      const pg = fakePg({
        'SELECT target_id': [{ target_id: '70000000002', status: 'new' }],
      });

      await serviceWith(pg).resolveReport('r1', {
        action: 'content_removed',
        moderator: 'admin',
      });

      expect(pg.calls.some((c) => c.sql.includes('UPDATE user_id'))).toBe(false);
      const upd = pg.calls.find((c) => c.sql.includes('UPDATE user_reports'));
      expect(upd!.params).toContain('resolved');
    });

    it('запоминает, кто разобрал', async () => {
      const pg = fakePg({
        'SELECT target_id': [{ target_id: '2', status: 'new' }],
      });

      await serviceWith(pg).resolveReport('r1', {
        action: 'dismiss',
        moderator: '79030169187',
      });

      const upd = pg.calls.find((c) => c.sql.includes('UPDATE user_reports'));
      expect(upd!.params).toContain('79030169187');
      expect(upd!.params).toContain('dismissed');
    });
  });

  describe('reportsSummary', () => {
    it('отдаёт числа для бейджа', async () => {
      const pg = fakePg({ 'FROM user_reports WHERE status': [{ open: 7, overdue: 2 }] });
      expect(await serviceWith(pg).reportsSummary()).toEqual({ open: 7, overdue: 2 });
    });

    it('пустая очередь — нули, а не undefined', async () => {
      const pg = fakePg();
      expect(await serviceWith(pg).reportsSummary()).toEqual({ open: 0, overdue: 0 });
    });
  });
});
