import { AdminService } from './admin.service';

function fakePg(rows: Record<string, any[]> = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
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

describe('устройства в админке', () => {
  describe('разрез по пользователю', () => {
    it('отдаёт устройства одного человека, свежие первыми', async () => {
      const pg = fakePg();
      await new AdminService(pg as any).getUserDevices('79088644408');

      const call = pg.calls[0];
      expect(call.sql).toContain('user_devices');
      expect(call.sql).toContain('ORDER BY last_seen DESC');
      expect(call.params).toContain('79088644408');
    });
  });

  describe('сводка', () => {
    // Два браузера у одного человека не должны дать двойку в «десктоп».
    it('считает РАЗЛИЧНЫХ людей, а не строки', async () => {
      const pg = fakePg();
      await new AdminService(pg as any).getDeviceStats();

      expect(pg.calls.some((c) => c.sql.includes('COUNT(DISTINCT user_id)'))).toBe(true);
    });

    it('ограничивает окно свежестью, а не берёт всё подряд', async () => {
      const pg = fakePg();
      await new AdminService(pg as any).getDeviceStats();

      expect(pg.calls.every((c) => c.sql.includes('last_seen'))).toBe(true);
    });

    it('отдаёт разбивки по платформе, ОС и браузеру', async () => {
      const stats = await new AdminService(fakePg() as any).getDeviceStats();

      expect(stats).toHaveProperty('byPlatform');
      expect(stats).toHaveProperty('byOs');
      expect(stats).toHaveProperty('byBrowser');
    });

    // Ради этих двух чисел мы и храним все устройства, а не последнее.
    it('отдаёт «трогали мобилку» и «только мобилка»', async () => {
      const stats = await new AdminService(fakePg() as any).getDeviceStats();

      expect(stats).toHaveProperty('mobileTouched');
      expect(stats).toHaveProperty('mobileOnly');
    });

    // Без этой доли классификатор молча врёт: относит непонятное в «прочие»
    // и выглядит точным.
    it('отдаёт долю неразобранного', async () => {
      const stats = await new AdminService(fakePg() as any).getDeviceStats();

      expect(stats).toHaveProperty('unknownUsers');
    });
  });
});
