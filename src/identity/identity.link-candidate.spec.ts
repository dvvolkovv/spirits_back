import * as fs from 'fs';
import * as path from 'path';
import { IdentityService } from './identity.service';

/**
 * Вход по почте/OAuth не должен молча заводить второй аккаунт человеку,
 * который уже зарегистрирован по телефону.
 *
 * Инцидент 19.09.2026: victoria-337@mail.ru вписала почту в профиль
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
  /** Был ли запрос, создающий НОВУЮ строку пользователя. */
  get createdUser(): boolean {
    return this.queries.some((q) => /INSERT INTO user_id\b/i.test(q.sql));
  }
}

/**
 * Пустая база + один телефонный аккаунт, у которого в профиле указана почта.
 * Ровно конфигурация Victoria на утро 19.09.2026.
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
        ? { rows: [{ internal_id: '79275527425', primary_phone: '79275527425' }] }
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

    const r = await svc.resolveOrCreate('email', { email: 'victoria-337@mail.ru' });

    expect(r.status).toBe('link_required');
    expect(r).toMatchObject({ candidateUserId: '79275527425' });
    // Главное утверждение теста: второй аккаунт НЕ заведён.
    expect(pg.createdUser).toBe(false);
  });

  it('подсказка по номеру скрывает всё, кроме последних четырёх цифр', async () => {
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r: any = await svc.resolveOrCreate('email', { email: 'victoria-337@mail.ru' });

    expect(r.phoneHint).toContain('7425');
    // Ложно-зелёный здесь стоил бы утечки: проверяем, что середина номера
    // действительно не видна, а не только что хвост на месте.
    expect(r.phoneHint).not.toContain('9275');
    expect(r.phoneHint).not.toContain('552');
  });

  it('то же самое для google — дыра не в почтовом контроллере, а в резолвере', async () => {
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('google', {
      sub: 'g-115495847139483989335',
      email: 'victoria-337@mail.ru',
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

    const r = await svc.resolveOrCreate('email', { email: 'victoria-337@mail.ru' });

    expect(r.status).toBe('ok');
    expect(pg.createdUser).toBe(true);
  });

  it('forceNew заводит новый аккаунт несмотря на кандидата', async () => {
    // Человек мог потерять номер. Без этого выхода он окажется заперт.
    const pg = pgWithProfileEmailOwner();
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('email', { email: 'victoria-337@mail.ru' }, { forceNew: true });

    expect(r.status).toBe('ok');
    expect(pg.createdUser).toBe(true);
  });

  it('существующая связка выигрывает у кандидата', async () => {
    const pg = new FakePg((sql) => {
      if (/FROM user_identities WHERE provider/i.test(sql)) return { rows: [{ user_id: 'u-1' }] };
      return { rows: [] };
    });
    const svc = new IdentityService(pg as any);

    const r = await svc.resolveOrCreate('email', { email: 'victoria-337@mail.ru' });

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
      email: 'victoria-337@mail.ru',
      emailVerified: false,
    });

    expect(r.status).toBe('ok');
    expect(pg.queries.some((q) => /JOIN ai_profiles_consolidated/i.test(q.sql))).toBe(false);
  });
});

describe('mergeAccounts — баланс и история не должны сгорать', () => {
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
    const svc = new IdentityService(pg as any);

    await svc.mergeAccounts('orphan-1', 'target-1');

    const addCalls = calls.filter((c) => /add_user_tokens/i.test(c.sql));
    expect(addCalls).toHaveLength(2);
    // Целевой аккаунт пополняется ПЕРВЫМ: настоящей транзакции здесь нет
    // (BEGIN/COMMIT через пул уезжают на разные соединения), поэтому обрыв
    // между шагами должен задваивать баланс, а не сжигать его.
    expect(addCalls[0].params).toEqual(expect.arrayContaining(['target-1', 8897]));
    expect(addCalls[1].params).toEqual(expect.arrayContaining(['orphan-1', -8897]));

    // Порядок важен: пометить deleted раньше переноса — потерять баланс.
    const deletedAt = calls.findIndex((c) => /state = 'deleted'/i.test(c.sql));
    const lastAdd = calls.map((c) => /add_user_tokens/i.test(c.sql)).lastIndexOf(true);
    expect(lastAdd).toBeLessThan(deletedAt);
  });

  it('не зовёт add_user_tokens на нулевом балансе', async () => {
    const calls: string[] = [];
    const pg = new FakePg((sql) => {
      calls.push(sql);
      if (/SELECT[\s\S]*tokens[\s\S]*FROM ai_profiles_consolidated/i.test(sql)) {
        return { rows: [{ tokens: 0 }] };
      }
      return { rows: [] };
    });
    const svc = new IdentityService(pg as any);

    await svc.mergeAccounts('orphan-2', 'target-2');

    expect(calls.some((s) => /add_user_tokens/i.test(s))).toBe(false);
    expect(calls.some((s) => /state = 'deleted'/i.test(s))).toBe(true);
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
