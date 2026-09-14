import { IntegrationFlagsService, INTEGRATIONS } from './integration-flags.service';

/**
 * Выключатель ценен ровно одним свойством: он выключает. Поэтому проверяем не
 * «сохранилось ли значение», а поведение на границах — нет строки, нет базы,
 * неизвестный ключ.
 */
describe('IntegrationFlagsService', () => {
  const make = (rows: any[] = []) => {
    const pg = { query: jest.fn().mockResolvedValue({ rows }) };
    return { pg, svc: new IntegrationFlagsService(pg as any) };
  };

  describe('enabled', () => {
    it('нет строки — выключено', async () => {
      // Главное свойство таблицы: интеграция, приехавшая с выкаткой кода, не
      // начинает работать сама.
      const { svc } = make([]);
      expect(await svc.enabled('meeting:meet')).toBe(false);
    });

    it('строка с enabled=false — выключено', async () => {
      const { svc } = make([{ key: 'meeting:meet', enabled: false }]);
      expect(await svc.enabled('meeting:meet')).toBe(false);
    });

    it('строка с enabled=true — включено', async () => {
      const { svc } = make([{ key: 'meeting:meet', enabled: true }]);
      expect(await svc.enabled('meeting:meet')).toBe(true);
    });

    it('база недоступна — выключено, а не исключение', async () => {
      // Вызывающие решают, показать ли карточку и пускать ли во встречу;
      // падать там нельзя. Но и включать при сбое нельзя тем более — ровно от
      // этого таблица и заводилась.
      const pg = { query: jest.fn().mockRejectedValue(new Error('соединение потеряно')) };
      const svc = new IntegrationFlagsService(pg as any);
      jest.spyOn((svc as any).logger, 'error').mockImplementation(() => {});
      expect(await svc.enabled('meeting:meet')).toBe(false);
    });

    it('снимок переиспользуется, а не спрашивается на каждое сообщение', async () => {
      // Распознавание ссылки на встречу висит на КАЖДОМ сообщении чата.
      const { pg, svc } = make([{ key: 'meeting:meet', enabled: true }]);
      await svc.enabled('meeting:meet');
      await svc.enabled('meeting:zoom');
      await svc.enabled('meeting:talerid');
      expect(pg.query).toHaveBeenCalledTimes(1);
    });

    it('переключение сбрасывает снимок сразу', async () => {
      // Админ жмёт переключатель и тут же идёт проверять: ждать срока жизни
      // кеша в этот момент невыносимо.
      const { pg, svc } = make([{ key: 'meeting:meet', enabled: false }]);
      expect(await svc.enabled('meeting:meet')).toBe(false);
      pg.query.mockResolvedValue({ rows: [{ key: 'meeting:meet', enabled: true }] });
      await svc.set('meeting:meet', true, 'admin-1');
      expect(await svc.enabled('meeting:meet')).toBe(true);
    });
  });

  describe('list', () => {
    it('показывает и те интеграции, которых в базе ещё нет', async () => {
      // Иначе в админке не было бы переключателя для того, что ни разу не
      // включали, — то есть включить его было бы нечем.
      const { svc } = make([{ key: 'meeting:meet', enabled: true, updated_at: new Date(0), updated_by: 'admin-1' }]);
      const list = await svc.list();
      expect(list).toHaveLength(INTEGRATIONS.length);
      expect(list.find((i) => i.key === 'meeting:meet')).toMatchObject({
        enabled: true, updatedBy: 'admin-1',
      });
      expect(list.find((i) => i.key === 'meeting:zoom')).toMatchObject({ enabled: false });
    });

    it('у каждой интеграции есть человеческое название', async () => {
      const { svc } = make([]);
      for (const i of await svc.list()) expect(i.title.length).toBeGreaterThan(0);
    });
  });

  describe('set', () => {
    it('пишет значение и автора', async () => {
      const { pg, svc } = make([]);
      await svc.set('meeting:zoom', true, 'admin-7');
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO integration_flags');
      expect(params).toEqual(['meeting:zoom', true, 'admin-7']);
    });

    it('неизвестный ключ отвергается', async () => {
      // Опечатка завела бы строку, которую никто никогда не прочитает, и
      // выглядело бы это как «включил, а не работает».
      const { pg, svc } = make([]);
      await expect(svc.set('meeting:skype', true)).rejects.toThrow(/unknown integration/);
      expect(pg.query).not.toHaveBeenCalled();
    });
  });
});
