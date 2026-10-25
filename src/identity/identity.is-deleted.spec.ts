import { IdentityService } from './identity.service';

/// Помечен ли аккаунт удалённым — одна проверка на всех.
///
/// Её спрашивают продление сессии (AuthService.refreshTokens) и вход через
/// мини-приложение Telegram (TmaController). Раньше она жила приватной в
/// AuthService, и мини-приложение состояние аккаунта не проверяло вовсе.
describe('IdentityService.isDeleted', () => {
  function svc(rows: any[] | Error) {
    const pg = {
      query: jest.fn(async () => {
        if (rows instanceof Error) throw rows;
        return { rows };
      }),
    };
    return { identity: new IdentityService(pg as any), pg };
  }

  it('аккаунт в состоянии deleted — удалён', async () => {
    const { identity, pg } = svc([{ state: 'deleted' }]);
    expect(await identity.isDeleted('u1')).toBe(true);
    expect(pg.query.mock.calls[0][1]).toEqual(['u1']);
  });

  it('активный аккаунт — не удалён', async () => {
    expect(await svc([{ state: 'active' }]).identity.isDeleted('u1')).toBe(false);
  });

  it('строки нет — не удалён: решать «кто это» — дело вызывающего', async () => {
    expect(await svc([]).identity.isDeleted('u1')).toBe(false);
  });

  // Недоступный Postgres не должен разлогинивать всех живых пользователей разом.
  it('ошибка базы — не удалён', async () => {
    expect(await svc(new Error('pg down')).identity.isDeleted('u1')).toBe(false);
  });

  it('без базы — не удалён', async () => {
    expect(await new IdentityService().isDeleted('u1')).toBe(false);
  });
});
