import { AlertBotAccess } from './alert-bot.access';
import { alertBotAllowedChat } from './alert-bot.config';

describe('доступ бота алертов', () => {
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
  it('слушает только личку и группы из TELEGRAM_CHAT_ID', () => {
    process.env.TELEGRAM_CHAT_ID = '-1001,-1002';
    expect(alertBotAllowedChat('1', 'private')).toBe(true);
    expect(alertBotAllowedChat('-1001', 'supergroup')).toBe(true);
    expect(alertBotAllowedChat('-1003', 'supergroup')).toBe(false);
  });
});
