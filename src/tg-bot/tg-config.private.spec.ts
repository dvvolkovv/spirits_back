import { TgConfigService } from './tg-config.service';

describe('ensurePrivateConfig', () => {
  const pg = { query: jest.fn() };
  const svc = new TgConfigService(pg as any, {} as any);

  beforeEach(() => jest.resetAllMocks());

  it('возвращает существующий конфиг, ничего не вставляя', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'cfg-1', owner_user_id: 'u-1', tg_chat_id: '777', status: 'active' }] });

    const cfg = await svc.ensurePrivateConfig('u-1', 777);

    expect(cfg.id).toBe('cfg-1');
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('личку, заглушённую прежним /silent в личке, будит: бот снова отвечает один на один', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [{ id: 'cfg-1', owner_user_id: 'u-1', tg_chat_id: '777', status: 'silent' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg-1', owner_user_id: 'u-1', tg_chat_id: '777', status: 'active' }] });

    const cfg = await svc.ensurePrivateConfig('u-1', 777);

    expect(cfg.status).toBe('active');
    expect(pg.query.mock.calls[1][0]).toMatch(/UPDATE tg_bot_configs SET status = 'active'/);
    expect(pg.query.mock.calls[1][1]).toEqual(['cfg-1']);
    // Только молчащую: архив, случившийся между SELECT и UPDATE, не оживляем.
    expect(pg.query.mock.calls[1][0]).toMatch(/AND status = 'silent'/);
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

  // Личка Telegram, которым раньше владел другой аккаунт Linkeon: Telegram
  // отвязали (или аккаунт удалили), и теперь он привязан к новому. Конфиг
  // ищется по tg_chat_id, и без проверки владельца чат нового человека шёл бы
  // через конфиг прежнего: списания — прежнему, его профиль — в ответы, чат —
  // в его кабинете.
  it.each(['active', 'silent'])('чужой конфиг лички (%s) архивируется, новому владельцу заводится свой', async (status) => {
    pg.query
      .mockResolvedValueOnce({ rows: [{ id: 'cfg-a', owner_user_id: 'u-a', tg_chat_id: '777', status }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // архив чужого
      .mockResolvedValueOnce({ rows: [] }) // профиль нового владельца
      .mockResolvedValueOnce({ rows: [{ id: 'cfg-b', owner_user_id: 'u-b', tg_chat_id: '777', status: 'active' }] }); // insert

    const cfg = await svc.ensurePrivateConfig('u-b', 777);

    expect(cfg.id).toBe('cfg-b');
    const [archiveSql, archiveParams] = pg.query.mock.calls[1];
    expect(archiveSql).toMatch(/UPDATE tg_bot_configs\s+SET status = 'archived', archived_at = now\(\)/);
    // Только этот конфиг, только пока он чужой и живой: гонка с владельцем,
    // успевшим его разбудить или заархивировать, не трогает лишнего.
    expect(archiveSql).toMatch(/WHERE id = \$1\s+AND owner_user_id <> \$2\s+AND status IN \('active','silent'\)/);
    expect(archiveParams).toEqual(['cfg-a', 'u-b']);
    // Чужое не будится: никакого UPDATE ... SET status = 'active'.
    expect(pg.query.mock.calls.some(([sql]) => /SET status = 'active'/.test(sql))).toBe(false);
    // Архив — ДО вставки: иначе её отбил бы idx_tg_bot_configs_active_chat.
    const insert = pg.query.mock.calls[3];
    expect(insert[0]).toContain('INSERT INTO tg_bot_configs');
    expect(insert[1][0]).toBe('u-b');
    expect(insert[1][1]).toBe(777);
    expect(pg.query).toHaveBeenCalledTimes(4);
  });
});
