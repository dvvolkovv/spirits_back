import { AlertBotAccess } from './alert-bot.access';
import { alertBotAllowedChat } from './alert-bot.config';

const SAVED_TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

describe('доступ бота алертов', () => {
  afterEach(() => {
    jest.useRealTimers();
    if (SAVED_TELEGRAM_CHAT_ID === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = SAVED_TELEGRAM_CHAT_ID;
  });

  function harness(rows: any[]) {
    const pg = { query: jest.fn(async () => ({ rows })) };
    return { pg, access: new AlertBotAccess(pg as any) };
  }
  it('Telegram админа даёт аккаунт Linkeon', async () => {
    const { access } = harness([{ user_id: 'u-admin', isadmin: true }]);
    expect(await access.resolveTelegram(111)).toEqual({ userId: 'u-admin', isAdmin: true });
  });
  it('не привязанный и не-админ не проходят', async () => {
    expect(await harness([]).access.resolveTelegram(111)).toEqual({ userId: null, isAdmin: false });
    expect(await harness([{ user_id: 'u-user', isadmin: false }]).access.resolveTelegram(222)).toEqual({ userId: 'u-user', isAdmin: false });
  });
  it('UUID аккаунта поддерживается, проверка кэшируется на 60 секунд', async () => {
    const { access, pg } = harness([{ user_id: '11111111-1111-4111-8111-111111111111', isadmin: true }]);
    await access.resolveTelegram(111);
    await access.resolveTelegram(111);
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(await access.isAdminUserId('11111111-1111-4111-8111-111111111111')).toBe(true);
  });
  it('запись в кэше истекает через 60 секунд', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const { access, pg } = harness([{ user_id: 'u-admin', isadmin: true }]);
    await access.resolveTelegram(111);
    jest.advanceTimersByTime(59_999);
    await access.resolveTelegram(111);
    expect(pg.query).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await access.resolveTelegram(111);
    expect(pg.query).toHaveBeenCalledTimes(2);
  });
  it('при записи удаляет истёкшие записи кэша', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const { access } = harness([]);
    await access.resolveTelegram(1);
    await access.resolveTelegram(2);
    jest.advanceTimersByTime(60_001);
    await access.resolveTelegram(3);
    expect((access as any).cache.size).toBe(1);
    expect((access as any).cache.has('tg:1')).toBe(false);
    expect((access as any).cache.has('tg:2')).toBe(false);
  });
  it('ограничивает кэш 1000 записями и вытесняет самую старую', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const { access, pg } = harness([]);
    for (let i = 0; i < 1000; i++) await access.resolveTelegram(i);
    await access.resolveTelegram(1000);
    expect((access as any).cache.size).toBe(1000);
    expect((access as any).cache.has('tg:0')).toBe(false);
    expect((access as any).cache.has('tg:1')).toBe(true);
    await access.resolveTelegram(0);
    expect(pg.query).toHaveBeenCalledTimes(1002);
  });
  it('не кэширует отклонённый pg.query', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const pg = {
      query: jest.fn()
        .mockRejectedValueOnce(new Error('synthetic pg failure'))
        .mockResolvedValueOnce({ rows: [] }),
    };
    const access = new AlertBotAccess(pg as any);
    await expect(access.resolveTelegram(111)).rejects.toThrow('synthetic pg failure');
    await expect(access.resolveTelegram(111)).resolves.toEqual({ userId: null, isAdmin: false });
    expect(pg.query).toHaveBeenCalledTimes(2);
  });
  it('слушает только личку и группы из TELEGRAM_CHAT_ID', () => {
    process.env.TELEGRAM_CHAT_ID = '-1001,-1002';
    expect(alertBotAllowedChat('1', 'private')).toBe(true);
    expect(alertBotAllowedChat('-1001', 'group')).toBe(true);
    expect(alertBotAllowedChat('-1001', 'supergroup')).toBe(true);
    expect(alertBotAllowedChat('-1003', 'supergroup')).toBe(false);
    expect(alertBotAllowedChat('-1001', 'channel')).toBe(false);
  });
});
