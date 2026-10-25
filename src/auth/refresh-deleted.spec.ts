import { AuthService } from './auth.service';
import { IdentityService } from '../identity/identity.service';
import { JwtService } from '../common/services/jwt.service';

/// Продление сессии не воскрешает удалённый аккаунт.
///
/// Удаление рвёт связки входа, но на руках у клиента остаётся выданный раньше
/// refresh-токен. Здесь настоящие AuthService.refreshTokens,
/// IdentityService.isDeleted и JwtService — подменена только база.
describe('AuthService.refreshTokens и удалённый аккаунт', () => {
  function makeService(states: Record<string, string>) {
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (/SELECT state FROM user_id WHERE internal_id = \$1/.test(sql)) {
          return { rows: params[0] in states ? [{ state: states[params[0]] }] : [] };
        }
        return { rows: [] };
      }),
    };
    const jwt = new JwtService();
    const identity = new IdentityService(pg as any);
    const auth = new AuthService(pg as any, {} as any, jwt, identity);
    return { auth, jwt };
  }

  it('удалённому аккаунту — null, новых токенов нет', async () => {
    const { auth, jwt } = makeService({ 'u-del': 'deleted' });
    expect(await auth.refreshTokens(jwt.signRefresh('u-del'))).toBeNull();
  });

  it('живому — новая пара токенов на тот же аккаунт', async () => {
    const { auth, jwt } = makeService({ 'u-live': 'active' });
    const r = await auth.refreshTokens(jwt.signRefresh('u-live'));
    expect(r?.userId).toBe('u-live');
    expect(jwt.verify(r!['refresh-token'])).toMatchObject({ userId: 'u-live', type: 'refresh' });
  });
});
