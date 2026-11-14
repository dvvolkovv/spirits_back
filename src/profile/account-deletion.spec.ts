import { AccountDeletionJobs } from '../account-deletion/account-deletion.jobs';
import { AccountDeletionPlanner } from '../account-deletion/account-deletion.planner';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type { DeletionExecution, DeletionJobRow } from '../account-deletion/account-deletion.types';
import { IdentityService } from '../identity/identity.service';
import { BusinessProfileService } from '../business-profile/business-profile.service';
import { ProfileAccountDeletionAdapter } from './profile-account-deletion.adapter';
import { ProfileAccountDeletionRecapture } from './profile-account-deletion.discovery';

/// Удаление аккаунта должно быть удалением, а не деактивацией.
///
/// Заведено по живой поломке, найденной при съёмке видео для Apple: удаление
/// отвечало 200, а тот же пароль пускал обратно. Причин было две — связки
/// входа переживали удаление, и связывание отдельной строкой поднимало
/// state обратно в active. Правило 5.1.1(v) считает такое деактивацией.
///
/// Здесь не проверяется текст SQL: он может быть любым, важно наблюдаемое
/// поведение. Поэтому «база» ниже — крошечная модель таблиц, и тесты
/// спрашивают её о состоянии так же, как о нём спросит вход.
///
/// С Task 17 наблюдаемое поведение даёт НЕ ProfileService.deleteProfile
/// (он лишён собственных SQL/network вызовов), а fenced-адаптер
/// account.core.*: повторный capture файлов, граф, затем одна транзакция
/// (lock + deleteOwnedCoreRows). Вход в удаление — begin() координатора
/// (Task 18) — здесь симулируется постановкой поколения (state='deleted',
/// deletion_id, deleted_at) прямо в модель: адаптер обязан видеть то же
/// состояние, что увидит после настоящего begin().

/// Модель того, что нужно этим тестам: строки пользователей, связок входа,
/// профиля,TG-связок и служебные таблицы deletion-pipeline.
class FakeDb {
  users = new Map<string, any>();
  identities: any[] = [];
  /** user_id → profile_data. Моделирует ai_profiles_consolidated. */
  profiles = new Map<string, any>();
  /** Связки бота: linkeon_user_id ↔ tg_user_id (1:1). Моделирует tg_user_identities. */
  tgIdentities: Array<{ linkeon_user_id: string; tg_user_id: number }> = [];

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT profile_data FROM ai_profiles_consolidated')) {
      const p = this.profiles.get(params[0]);
      return { rows: p ? [{ profile_data: p }] : [] };
    }
    if (s.startsWith("UPDATE ai_profiles_consolidated SET profile_data = '{}'")) {
      if (this.profiles.has(params[0])) this.profiles.set(params[0], {});
      return { rows: [] };
    }
    // merge(): SET profile_data = jsonb_set(...), updated_at = now() — не
    // "SET updated_at" первым, порядок колонок в реальном запросе другой.
    // $1 — уже само содержимое ветки {business}, $2 — user_id.
    if (s.startsWith('UPDATE ai_profiles_consolidated SET profile_data = jsonb_set(')) {
      const has = this.profiles.has(params[1]);
      if (has) {
        const prev = this.profiles.get(params[1]) || {};
        this.profiles.set(params[1], { ...prev, business: JSON.parse(params[0]) });
      }
      // rowCount обязателен: BusinessProfileService.merge читает res.rowCount,
      // чтобы понять, задел ли UPDATE существующую строку. Без него merge
      // решает, что строки нет, и молча не сохраняет карточку.
      return { rows: [], rowCount: has ? 1 : 0 };
    }
    if (s.startsWith('DELETE FROM tg_user_identities WHERE linkeon_user_id')) {
      this.tgIdentities = this.tgIdentities.filter((i) => i.linkeon_user_id !== params[0]);
      return { rows: [] };
    }
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
    // ---- Deletion-pipeline (Task 17) ----
    // Fenced-чтение поколения для повторного capture файлов.
    if (s.startsWith('SELECT deleted_at FROM user_id')) {
      const u = this.users.get(params[0]);
      const ok = !!u && u.state === 'deleted' && u.deletion_id === params[1];
      return ok
        ? { rows: [{ deleted_at: u.deleted_at }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // Keyset-страница истории для discoverChatFiles: в этой модели истории
    // нет — файлы не переоткрываются.
    if (s.startsWith('SELECT h.id, h.content FROM custom_chat_history')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT 1 FROM account_deletion_jobs')) {
      // Проверка незавершённых stop-задач (assertNoImmediateBlockers).
      if (s.includes("LIKE '%.stop'")) return { rows: [], rowCount: 0 };
      // assertCurrent и lockAndAssertCurrent: params [jobId, userId, deletionId, ...].
      const u = this.users.get(params[1]);
      const ok = !!u && u.state === 'deleted' && u.deletion_id === params[2];
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT state FROM user_id')) {
      const u = this.users.get(params[0]);
      return { rows: u ? [{ state: u.state }] : [] };
    }
    if (s.startsWith('SELECT password_hash FROM user_id')) {
      const u = this.users.get(params[0]);
      return { rows: u ? [{ password_hash: u.password_hash }] : [] };
    }
    // Tombstone (deleteOwnedCoreRows): гасит пароль/почту/бонус, НЕ трогая
    // state/deletion_id — поколение принадлежит begin()/reactivation.
    // Должен стоять ДО общего 'UPDATE user_id SET password_hash' (identity).
    if (s.startsWith('UPDATE user_id SET password_hash = NULL')) {
      const u = this.users.get(params[0]);
      if (u && u.state === 'deleted' && u.deletion_id === params[1]) {
        Object.assign(u, {
          password_hash: null, primary_email: null, welcome_bonus_at: null,
        });
      }
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

  /** inTransaction (blog-slot-claim): выделенное соединение из того же пула. */
  async getClient() {
    return {
      query: (sql: string, params: any[] = []) => this.query(sql, params),
      release: () => undefined,
    };
  }
}

function makeServices(db: FakeDb) {
  const neo4j = { deleteUserGraphStrict: jest.fn().mockResolvedValue(undefined) };
  const identity = new IdentityService(db as any);
  const jobs = new AccountDeletionJobs(db as any);
  // env не передаём: publicBaseUrl из process.env в юнит-среде пустой, но
  // история в модели и так пуста — discovery не находит файлов без сети.
  const recapture = new ProfileAccountDeletionRecapture(db as any, new AccountDeletionPlanner([]));
  const adapter = new ProfileAccountDeletionAdapter(
    db as any, jobs, recapture, neo4j as any, new AccountDeletionRegistry(),
  );
  return { identity, neo4j, jobs, adapter };
}

describe('удаление аккаунта', () => {
  let db: FakeDb;
  let identity: IdentityService;
  let neo4j: any;
  let jobs: AccountDeletionJobs;
  let adapter: ProfileAccountDeletionAdapter;

/**
 * resolveOrCreate отдаёт union: у него есть вариант link_required, когда
 * почта указана в профиле чужого аккаунта. В этих сценариях база пустая,
 * кандидата взяться неоткуда — но разворачивать результат надо явно.
 */
function ok<T extends { status: string }>(r: T): Extract<T, { status: 'ok' }> {
  if (r.status !== 'ok') throw new Error(`ожидался ok, получен ${r.status}`);
  return r as Extract<T, { status: 'ok' }>;
}

  let deletionSeq = 0;

  /**
   * Полный путь удаления, каким его видит адаптер: begin() (Task 18) ставит
   * поколение, затем fenced core finalize.
   */
  async function deleteAccount(userId: string): Promise<void> {
    if (!db.users.has(userId)) {
      db.users.set(userId, { state: 'active', welcome_bonus_at: null, password_hash: null });
    }
    const u = db.users.get(userId);
    const deletionId = `11111111-1111-4111-8111-${String(++deletionSeq).padStart(12, '0')}`;
    Object.assign(u, {
      state: 'deleted',
      deletion_id: deletionId,
      deleted_at: new Date('2026-11-01T00:00:00.000Z'),
    });
    const job: DeletionJobRow = {
      id: `job-core-${deletionSeq}`,
      deletionId,
      userId,
      resourceType: 'account.core.immediate',
      resourceKey: 'account',
      phase: 'immediate',
      payload: {},
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(),
      leaseUntil: new Date(Date.now() + 300_000),
      lastErrorKind: null,
    };
    const ctx: DeletionExecution = {
      db: db as any,
      assertCurrent: (j: DeletionJobRow) => jobs.assertCurrent(j),
    };
    await adapter.execute(job, ctx);
  }

  beforeEach(() => {
    db = new FakeDb();
    deletionSeq = 0;
    ({ identity, neo4j, jobs, adapter } = makeServices(db));
  });

  it('обрывает связки входа — по старой почте аккаунт больше не находится', async () => {
    const { userId } = ok(await identity.resolveOrCreate('email', { email: 'gone@example.com' }));
    expect(await identity.findIdentityByEmail('gone@example.com')).toEqual({ userId });

    await deleteAccount(userId);

    expect(await identity.findIdentityByEmail('gone@example.com')).toBeNull();
  });

  it('гасит пароль — старый больше не годится', async () => {
    const { userId } = ok(await identity.resolveOrCreate('email', { email: 'pw@example.com' }));
    await identity.setUserPasswordHash(userId, 'хеш-старого-пароля');
    expect(await identity.getUserPasswordHash(userId)).toBe('хеш-старого-пароля');

    await deleteAccount(userId);

    expect(await identity.getUserPasswordHash(userId)).toBeNull();
  });

  it('стирает граф профиля — иначе личные данные переживают удаление', async () => {
    const { userId } = ok(await identity.resolveOrCreate('email', { email: 'graph@example.com' }));
    await deleteAccount(userId);
    // Строгий вариант: legacy deleteUserGraph глотает ошибки (оставлен для
    // совместимости), deletion-pipeline обязан замечать сбой графа.
    expect(neo4j.deleteUserGraphStrict).toHaveBeenCalledWith(userId);
  });

  it('повторный вход тем же провайдером НЕ возвращает прежний аккаунт', async () => {
    const first = ok(await identity.resolveOrCreate('email', { email: 'again@example.com' }));
    await deleteAccount(first.userId);

    const second = ok(await identity.resolveOrCreate('email', { email: 'again@example.com' }));

    expect(second.isNew).toBe(true);
    expect(second.userId).not.toBe(first.userId);
  });

  it('телефон: строка та же, но аккаунт снова активен и со стартовым бонусом', async () => {
    // У телефонного входа internal_id — сам номер, и перерегистрация
    // неизбежно попадает в ту же строку. Она обязана стать активной, иначе
    // человек войдёт в аккаунт с состоянием deleted.
    const first = ok(await identity.resolveOrCreate('phone', { phone: '79990000001' }));
    await deleteAccount(first.userId);
    expect(db.users.get(first.userId).state).toBe('deleted');

    const second = ok(await identity.resolveOrCreate('phone', { phone: '79990000001' }));

    expect(second.userId).toBe(first.userId);
    expect(db.users.get(first.userId).state).toBe('active');
    // Бонус выдаётся заново: баланс удаление обнулило, и аккаунт должен
    // выглядеть новым, а не пустым.
    expect(db.users.get(first.userId).welcome_bonus_at).toBe('now');
  });

  it('рвёт и связку Telegram-бота — иначе мини-приложение снова впускает в удалённый аккаунт', async () => {
    // Мини-приложение ищет «старожилов бота» в tg_user_identities и по найденной
    // строке выдаёт токены. Пока строка переживала удаление, Telegram удалённого
    // аккаунта входил в него обратно — и заодно заново заводил связку входа.
    const { userId } = ok(await identity.resolveOrCreate('phone', { phone: '79990000002' }));
    db.tgIdentities.push({ linkeon_user_id: userId, tg_user_id: 4242 });
    db.tgIdentities.push({ linkeon_user_id: 'someone-else', tg_user_id: 4343 });

    await deleteAccount(userId);

    expect(db.tgIdentities.find((i) => i.linkeon_user_id === userId)).toBeUndefined();
    // Чужая связка на месте: удаление не должно задевать соседей.
    expect(db.tgIdentities).toEqual([{ linkeon_user_id: 'someone-else', tg_user_id: 4343 }]);
  });

  it('уносит бизнес-карточку — она персональные данные о юрлице', async () => {
    const userId = 'u-biz-1';
    db.profiles.set(userId, {});
    const business = new BusinessProfileService(db as any);

    await business.merge(userId, { what: 'студия маникюра', tax_mode: 'usn_d' }, 'user');
    // Убеждаемся, что до удаления карточка действительно есть: иначе тест
    // «после удаления пусто» прошёл бы и на пустой с самого начала базе.
    expect(await business.read(userId)).toMatchObject({
      what: { value: 'студия маникюра' },
    });

    await deleteAccount(userId);

    expect(await business.read(userId)).toEqual({});
  });
});
