import { TgConfigService } from './tg-config.service';

describe('ensurePrivateConfig', () => {
  const pg = { query: jest.fn() };
  const svc = new TgConfigService(pg as any, {} as any);

  beforeEach(() => jest.resetAllMocks());

  it('возвращает существующий конфиг, ничего не вставляя', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'cfg-1', tg_chat_id: '777' }] });

    const cfg = await svc.ensurePrivateConfig('u-1', 777);

    expect(cfg.id).toBe('cfg-1');
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('создаёт конфиг с addressing_mode=always и текущим ассистентом владельца', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [] }) // активного нет
      .mockResolvedValueOnce({ rows: [{ preferred_agent: 'Оля' }] }) // профиль
      .mockResolvedValueOnce({ rows: [{ id: '2' }] }) // id Оли
      .mockResolvedValueOnce({ rows: [{ id: 'cfg-new', tg_chat_id: '777' }] }); // insert

    const cfg = await svc.ensurePrivateConfig('u-1', 777);

    expect(cfg.id).toBe('cfg-new');
    const insert = pg.query.mock.calls[3];
    expect(insert[0]).toContain('INSERT INTO tg_bot_configs');
    expect(insert[1]).toContain('always');
    expect(insert[1]).toContain('2');
  });

  it('профиль без preferred_agent — в строку идёт дефолтный ассистент', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ preferred_agent: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg-new', tg_chat_id: '777' }] });

    await svc.ensurePrivateConfig('u-1', 777);

    const insert = pg.query.mock.calls[2];
    expect(insert[1]).toContain('12');
  });
});
