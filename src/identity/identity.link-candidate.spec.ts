import * as fs from 'fs';
import * as path from 'path';
import { IdentityService } from './identity.service';

/**
 * Вход по почте/OAuth не должен молча заводить второй аккаунт человеку,
 * который уже зарегистрирован по телефону.
 *
 * Инцидент 19.09.2026: maria.testova@example.org вписала почту в профиль
 * (ai_profiles_consolidated.email), вошла по magic link — и получила новый
 * UUID-аккаунт с отдельным приветственным бонусом. resolveOrCreate искал
 * совпадение только в user_identities, куда профильная почта не попадает.
 * На 21.09.2026 в той же ловушке оставался 31 аккаунт.
 */

type Handler = (sql: string, params: any[]) => any;

class FakePg {
  readonly queries: { sql: string; params: any[] }[] = [];
  constructor(private readonly handler: Handler) {}
  async query(sql: string, params: any[] = []) {
    this.queries.push({ sql, params });
    return this.handler(sql, params) ?? { rows: [] };
  }
  /**
   * Task 19 — перенос идентичностей при merge идёт внутри транзакции
   * (inTransaction(pg)): без getClient фейк не совместим с настоящим путём.
   * Запросы транзакции попадают в тот же handler и в тот же журнал.
   */
  async getClient() {
    return {
      query: (sql: string, params?: any[]) => this.query(sql, params ?? []),
      release: () => undefined,
    };
  }
  /** Был ли запрос, создающий НОВУЮ строку пользователя. */
  get createdUser(): boolean {
    return this.queries.some((q) => /INSERT INTO user_id\b/i.test(q.sql));
  }
}

/**
 * Пустая база + один телефонный аккаунт, у которого в профиле указана почта.
 * Ровно конфигурация Марии Тестовой на утро 19.09.2026.
 */
function pgWithProfileEmailOwner(opts: { loginable?: boolean } = {}) {
  const { loginable = true } = opts;
  return new FakePg((sql) => {
    // шаг 1 и шаг 2 resolveOrCreate — совпадений нет
    if (/FROM user_identities WHERE provider/i.test(sql)) return { rows: [] };
    if (/FROM user_identities WHERE email/i.test(sql)) return { rows: [] };
    // поиск кандидата по профильной почте
    if (/JOIN ai_profiles_consolidated/i.test(sql)) {
      return loginable
        ? { rows: [{ internal_id: '70005550009', primary_phone: '70005550009' }] }
        : { rows: [] };
    }
    if (/INSERT INTO user_id\b/i.test(sql)) return { rows: [{ internal_id: 'new-uuid' }] };
    return { rows: [] };
  });
}

describe('resolveOrCreate — кандидат на привязку вместо второго аккаунта', () => {
  it('вход по почте из чужого профиля не создаёт аккаунт, а просит привязку', async () => {
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('email', { email: 'maria.testova@example.org' });

    expect(r.status).toBe('link_required');
    expect(r).toMatchObject({ candidateUserId: '70005550009' });
    // Главное утверждение теста: второй аккаунт НЕ заведён.
    expect(pg.createdUser).toBe(false);
  });

  it('подсказка по номеру скрывает всё, кроме последних четырёх цифр', async () => {
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r: any = await svc.resolveOrCreate('email', { email: 'maria.testova@example.org' });

    expect(r.phoneHint).toContain('0009');
    // Ложно-зелёный здесь стоил бы утечки: проверяем, что середина номера
    // действительно не видна, а не только что хвост на месте.
    expect(r.phoneHint).not.toContain('0005');
    expect(r.phoneHint).not.toContain('555');
  });

  it('то же самое для google — дыра не в почтовом контроллере, а в резолвере', async () => {
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('google', {
      sub: 'g-000000000000000000001',
      email: 'maria.testova@example.org',
      emailVerified: true,
    });

    expect(r.status).toBe('link_required');
    expect(pg.createdUser).toBe(false);
  });

  it('аккаунт без рабочего входа кандидатом не считается', async () => {
    // Профильная почта совпала, но войти в тот аккаунт нечем — отправлять
    // туда человека значит запереть его вне обоих аккаунтов. Такой случай
    // создаёт новый аккаунт, как раньше.
    const pg = pgWithProfileEmailOwner({ loginable: false });
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('email', { email: 'maria.testova@example.org' });

    expect(r.status).toBe('ok');
    expect(pg.createdUser).toBe(true);
  });

  it('forceNew заводит новый аккаунт несмотря на кандидата', async () => {
    // Человек мог потерять номер. Без этого выхода он окажется заперт.
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('email', { email: 'maria.testova@example.org' }, { forceNew: true });

    expect(r.status).toBe('ok');
    expect(pg.createdUser).toBe(true);
  });

  it('существующая связка выигрывает у кандидата', async () => {
    const pg = new FakePg((sql) => {
      if (/FROM user_identities WHERE provider/i.test(sql)) return { rows: [{ user_id: 'u-1' }] };
      return { rows: [] };
    });
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('email', { email: 'maria.testova@example.org' });

    expect(r).toMatchObject({ status: 'ok', userId: 'u-1', isNew: false });
    // Кандидата даже не искали — вход состоялся на первом шаге.
    expect(pg.queries.some((q) => /JOIN ai_profiles_consolidated/i.test(q.sql))).toBe(false);
  });

  it('телефонный вход кандидата не ищет', async () => {
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('phone', { phone: '79991112233' });

    expect(r.status).toBe('ok');
    expect(pg.queries.some((q) => /JOIN ai_profiles_consolidated/i.test(q.sql))).toBe(false);
  });

  it('telegram кандидата не ищет — почты у него нет', async () => {
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('telegram', { sub: '42' });

    expect(r.status).toBe('ok');
    expect(pg.queries.some((q) => /JOIN ai_profiles_consolidated/i.test(q.sql))).toBe(false);
  });

  it('неподтверждённая почта провайдера кандидата не ищет', async () => {
    // Непроверенный адрес не доказывает владение ящиком: по нему нельзя
    // отправлять человека в чужой аккаунт.
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('apple', {
      sub: 'a-1',
      email: 'maria.testova@example.org',
      emailVerified: false,
    });

    expect(r.status).toBe('ok');
    expect(pg.queries.some((q) => /JOIN ai_profiles_consolidated/i.test(q.sql))).toBe(false);
  });
});

describe('mergeAccounts — баланс и история не должны сгорать', () => {
  /**
   * Task 19 — merge больше не помечает deleted напрямую: loser уходит через
   * deletion lifecycle (begin(loser,'merge') → stopOnly → перенос под
   * assertCurrent). Фейк пишет вызовы в ТОТ ЖЕ журнал, что и SQL, чтобы
   * порядок credit-first → begin → stop → move проверялся одной лентой.
   */
  function deletionFake(calls: { sql: string; params: any[] }[]) {
    return {
      begin: jest.fn(async (loserUserId: string, origin: string) => {
        calls.push({ sql: 'lifecycle.begin', params: [loserUserId, origin] });
        return {
          userId: loserUserId,
          deletionId: 'd-merge-1',
          deletedAt: new Date('2026-11-01T00:00:00.000Z'),
        };
      }),
      stopOnly: jest.fn(async (deletionId: string) => {
        calls.push({ sql: 'lifecycle.stopOnly', params: [deletionId] });
      }),
      assertCurrent: jest.fn(async () => {
        calls.push({ sql: 'lifecycle.assertCurrent', params: [] });
      }),
    };
  }

  function moduleRefFake(deletion: unknown) {
    return { get: () => deletion };
  }

  it('переносит баланс на целевой аккаунт перед пометкой deleted', async () => {
    // Прод 21.09.2026: на a375a4db и a752d49a, помеченных deleted прошлыми
    // слияниями, осталось 47 458 токенов — их не перенёс никто.
    const calls: { sql: string; params: any[] }[] = [];
    const pg = new FakePg((sql, params) => {
      calls.push({ sql, params });
      if (/SELECT[\s\S]*tokens[\s\S]*FROM ai_profiles_consolidated/i.test(sql)) {
        return { rows: [{ tokens: 8897 }] };
      }
      return { rows: [] };
    });
    const deletion = deletionFake(calls);
    const svc = new IdentityService(
      pg as any, undefined, undefined, moduleRefFake(deletion) as any,
    );

    await svc.mergeAccounts('orphan-1', 'target-1');

    const addCalls = calls.filter((c) => /add_user_tokens/i.test(c.sql));
    expect(addCalls).toHaveLength(2);
    // Целевой аккаунт пополняется ПЕРВЫМ: настоящей транзакции здесь нет
    // (BEGIN/COMMIT через пул уезжают на разные соединения), поэтому обрыв
    // между шагами должен задваивать баланс, а не сжигать его.
    expect(addCalls[0].params).toEqual(expect.arrayContaining(['target-1', 8897]));
    expect(addCalls[1].params).toEqual(expect.arrayContaining(['orphan-1', -8897]));

    // Порядок важен: пометить deleted раньше переноса — потерять баланс.
    // С Task 19 пометку (поколение удаления) ставит lifecycle.begin, поэтому
    // точка отсчёта — его вызов, а не прямой UPDATE.
    const lastAdd = calls.map((c) => /add_user_tokens/i.test(c.sql)).lastIndexOf(true);
    const beginIdx = calls.findIndex((c) => c.sql === 'lifecycle.begin');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(lastAdd).toBeLessThan(beginIdx);
    expect(deletion.begin).toHaveBeenCalledWith('orphan-1', 'merge');

    // Фиксированный порядок Task 19: begin → stopOnly → move-транзакция
    // (assertCurrent → перенос идентичностей). Внешние стопы — до переноса:
    // apple.revokeToken читает provider_refresh_token из user_identities loser.
    const stopIdx = calls.findIndex((c) => c.sql === 'lifecycle.stopOnly');
    const assertIdx = calls.findIndex((c) => c.sql === 'lifecycle.assertCurrent');
    const moveIdx = calls.findIndex((c) =>
      /UPDATE\s+user_identities\s+SET\s+user_id/i.test(c.sql));
    expect(deletion.stopOnly).toHaveBeenCalledWith('d-merge-1');
    expect(stopIdx).toBeGreaterThan(beginIdx);
    expect(assertIdx).toBeGreaterThan(stopIdx);
    expect(moveIdx).toBeGreaterThan(assertIdx);

    // Tombstone слитого аккаунта зачищается под защитой поколения: хэш пароля,
    // профильная почта и маркер приветственного бонуса — с тем же deletion_id.
    const tombstone = calls.find((c) => /password_hash\s*=\s*NULL/i.test(c.sql));
    expect(tombstone).toBeDefined();
    expect(tombstone!.sql).toMatch(/state\s*=\s*'deleted'/i);
    expect(tombstone!.params).toEqual(
      expect.arrayContaining(['orphan-1', 'd-merge-1']),
    );

    // Прямого UPDATE state='deleted' из mergeAccounts больше нет — поколение
    // создаёт lifecycle.begin (на реальной БД это покрыто merge-deletion.pg.spec).
    expect(calls.some((c) =>
      /UPDATE\s+user_id\s+SET\s+state\s*=\s*'deleted'/i.test(c.sql))).toBe(false);
  });

  it('не зовёт add_user_tokens на нулевом балансе', async () => {
    const calls: { sql: string; params: any[] }[] = [];
    const pg = new FakePg((sql, params) => {
      calls.push({ sql, params });
      if (/SELECT[\s\S]*tokens[\s\S]*FROM ai_profiles_consolidated/i.test(sql)) {
        return { rows: [{ tokens: 0 }] };
      }
      return { rows: [] };
    });
    const deletion = deletionFake(calls);
    const svc = new IdentityService(
      pg as any, undefined, undefined, moduleRefFake(deletion) as any,
    );

    await svc.mergeAccounts('orphan-2', 'target-2');

    expect(calls.some((c) => /add_user_tokens/i.test(c.sql))).toBe(false);
    // Пометка deleted + deletion_id — через lifecycle (begin c merge-origin),
    // а не прямым UPDATE.
    expect(deletion.begin).toHaveBeenCalledWith('orphan-2', 'merge');
    expect(calls.some((c) =>
      /UPDATE\s+user_id\s+SET\s+state\s*=\s*'deleted'/i.test(c.sql))).toBe(false);
  });

  it('без deletion lifecycle merge отказывается: полу-удалённых аккаунтов нет', async () => {
    // Guard в начале mergeAccounts: без lifecycle нельзя ни создать поколение,
    // ни исполнить стопы — явная ошибка вместо тихой половины пути. В проде
    // AccountDeletionModule @Global и lifecycle есть всегда; ветка достижима
    // только в unit-контурах и при сломанном DI.
    const pg = new FakePg(() => ({ rows: [] }));
    const svc = new IdentityService(pg as any);

    await expect(svc.mergeAccounts('orphan-3', 'target-3'))
      .rejects.toThrow(/deletion lifecycle/i);
    // Ничего не перенесено и никто не помечен.
    expect(pg.queries.some((q) => /add_user_tokens/i.test(q.sql))).toBe(false);
    expect(pg.queries.some((q) => /UPDATE\s+user_identities/i.test(q.sql))).toBe(false);
  });
});

describe('бэкфилл phone-связок не трогает email/OAuth аккаунты', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, 'migrations', '001_identity_init.sql'),
    'utf8',
  );

  it('вставляет только тем, у кого internal_id — номер', () => {
    // Файл переутверждается на каждом старте: без фильтра каждый новый
    // email-аккаунт получал связку provider='phone' со своим же UUID.
    const backfill = sql
      .replace(/--[^\n]*/g, '')
      .split(/INSERT INTO user_identities/i)
      .find((chunk) => /'phone'/.test(chunk) && /FROM user_id\b/.test(chunk));

    // Ложно-зелёный был бы здесь бесплатным: не найдя блок, тест прошёл бы
    // на пустом месте — ровно так уже промахивался тест про констрейнт.
    expect(backfill).toBeDefined();
    expect(backfill).toMatch(/internal_id\s*~\s*'\^\[0-9\]\+\$'/);
  });
});
