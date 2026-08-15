import { ProfileService } from './profile.service';
import { IdentityService } from '../identity/identity.service';

/// Удаление аккаунта должно быть удалением, а не деактивацией.
///
/// Заведено по живой поломке, найденной при съёмке видео для Apple: удаление
/// отвечало 200, а тот же пароль пускал обратно. Причин было две — связки
/// входа переживали удаление, и связывание отдельной строкой поднимало
/// state обратно в active. Правило 5.1.1(v) считает такое деактивацией.
///
/// Здесь не проверяется текст SQL: он может быть любым, важно наблюдаемое
/// поведение. Поэтому «база» ниже — крошечная модель двух таблиц, и тесты
/// спрашивают её о состоянии так же, как о нём спросит вход.

/// Модель того, что нужно этим тестам: строки пользователей и связок входа.
class FakeDb {
  users = new Map<string, any>();
  identities: any[] = [];

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('DELETE FROM user_identities WHERE user_id')) {
      this.identities = this.identities.filter((i) => i.user_id !== params[0]);
      return { rows: [] };
    }
    // Провайдер здесь зашит в текст запроса, а параметр всего один — это
    // поиск по почте из findIdentityByEmail, а не общий поиск связки.
    if (s.startsWith("SELECT user_id FROM user_identities WHERE provider = 'email'")) {
      const row = this.identities.find(
        (i) => i.provider === 'email' && i.provider_sub === params[0] && i.email_verified,
      );
      return { rows: row ? [{ user_id: row.user_id }] : [] };
    }
    if (s.startsWith('SELECT user_id FROM user_identities WHERE provider')) {
      const row = this.identities.find(
        (i) => i.provider === params[0] && i.provider_sub === params[1],
      );
      return { rows: row ? [{ user_id: row.user_id }] : [] };
    }
    if (s.startsWith('INSERT INTO user_identities')) {
      this.identities.push({
        user_id: params[0],
        provider: params[1],
        provider_sub: params[2],
        email: params[3],
        email_verified: params[4],
      });
      return { rows: [] };
    }
    if (s.startsWith('SELECT user_id FROM user_identities WHERE email')) {
      const row = this.identities.find((i) => i.email === params[0] && i.email_verified);
      return { rows: row ? [{ user_id: row.user_id }] : [] };
    }
    if (s.startsWith('SELECT state FROM user_id')) {
      const u = this.users.get(params[0]);
      return { rows: u ? [{ state: u.state }] : [] };
    }
    if (s.startsWith('SELECT password_hash FROM user_id')) {
      const u = this.users.get(params[0]);
      return { rows: u ? [{ password_hash: u.password_hash }] : [] };
    }
    if (s.startsWith('UPDATE user_id SET state = \'deleted\'')) {
      const u = this.users.get(params[0]);
      if (u) Object.assign(u, {
        state: 'deleted', password_hash: null,
        primary_email: null, welcome_bonus_at: null,
      });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE user_id SET state = \'active\'')) {
      const u = this.users.get(params[0]);
      if (u && u.state !== 'active') u.state = 'active';
      return { rows: [] };
    }
    if (s.startsWith('UPDATE user_id SET password_hash')) {
      const u = this.users.get(params[1]);
      if (u) u.password_hash = params[0];
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO user_id')) {
      // Две разные вставки. У телефонной internal_id — сам номер, и повтор
      // молча ничего не делает; у остальных провайдеров ключ генерирует база,
      // поэтому каждая регистрация даёт НОВУЮ строку.
      const byPhone = s.includes('primary_phone');
      const id = byPhone ? params[1] : `uid-${this.users.size + 1}`;
      if (!this.users.has(id)) {
        this.users.set(id, { state: 'active', welcome_bonus_at: null, password_hash: null });
      }
      return { rows: [{ internal_id: id }] };
    }
    if (s.startsWith('UPDATE user_id SET welcome_bonus_at')) {
      const u = this.users.get(params[0]);
      if (!u || u.welcome_bonus_at) return { rows: [] };
      u.welcome_bonus_at = 'now';
      return { rows: [{ internal_id: params[0] }] };
    }
    return { rows: [] };
  }
}

function makeServices(db: FakeDb) {
  const neo4j = { deleteUserGraph: jest.fn().mockResolvedValue(undefined) };
  const profile = new ProfileService(db as any, neo4j as any);
  const identity = new IdentityService(db as any);
  return { profile, identity, neo4j };
}

describe('удаление аккаунта', () => {
  let db: FakeDb;
  let profile: ProfileService;
  let identity: IdentityService;
  let neo4j: any;

  beforeEach(() => {
    db = new FakeDb();
    ({ profile, identity, neo4j } = makeServices(db));
  });

  it('обрывает связки входа — по старой почте аккаунт больше не находится', async () => {
    const { userId } = await identity.resolveOrCreate('email', { email: 'gone@example.com' });
    expect(await identity.findIdentityByEmail('gone@example.com')).toEqual({ userId });

    await profile.deleteProfile(userId);

    expect(await identity.findIdentityByEmail('gone@example.com')).toBeNull();
  });

  it('гасит пароль — старый больше не годится', async () => {
    const { userId } = await identity.resolveOrCreate('email', { email: 'pw@example.com' });
    await identity.setUserPasswordHash(userId, 'хеш-старого-пароля');
    expect(await identity.getUserPasswordHash(userId)).toBe('хеш-старого-пароля');

    await profile.deleteProfile(userId);

    expect(await identity.getUserPasswordHash(userId)).toBeNull();
  });

  it('стирает граф профиля — иначе личные данные переживают удаление', async () => {
    const { userId } = await identity.resolveOrCreate('email', { email: 'graph@example.com' });
    await profile.deleteProfile(userId);
    expect(neo4j.deleteUserGraph).toHaveBeenCalledWith(userId);
  });

  it('повторный вход тем же провайдером НЕ возвращает прежний аккаунт', async () => {
    const first = await identity.resolveOrCreate('email', { email: 'again@example.com' });
    await profile.deleteProfile(first.userId);

    const second = await identity.resolveOrCreate('email', { email: 'again@example.com' });

    expect(second.isNew).toBe(true);
    expect(second.userId).not.toBe(first.userId);
  });

  it('телефон: строка та же, но аккаунт снова активен и со стартовым бонусом', async () => {
    // У телефонного входа internal_id — сам номер, и перерегистрация
    // неизбежно попадает в ту же строку. Она обязана стать активной, иначе
    // человек войдёт в аккаунт с состоянием deleted.
    const first = await identity.resolveOrCreate('phone', { phone: '79990000001' });
    await profile.deleteProfile(first.userId);
    expect(db.users.get(first.userId).state).toBe('deleted');

    const second = await identity.resolveOrCreate('phone', { phone: '79990000001' });

    expect(second.userId).toBe(first.userId);
    expect(db.users.get(first.userId).state).toBe('active');
    // Бонус выдаётся заново: баланс удаление обнулило, и аккаунт должен
    // выглядеть новым, а не пустым.
    expect(db.users.get(first.userId).welcome_bonus_at).toBe('now');
  });
});
