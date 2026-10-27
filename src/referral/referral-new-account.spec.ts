import { ReferralService, REFERRAL_NEW_ACCOUNT_WINDOW_MS } from './referral.service';

/// Реферальная ссылка привязывает только НОВЫЙ аккаунт.
///
/// Веб зовёт регистрацию по ссылке при ЛЮБОМ входе, если в браузере сохранён
/// slug (он живёт там 7 дней). Без проверки «аккаунт новый» давний, ни к кому
/// не привязанный аккаунт получал бонус приглашённого, стоило ему перед входом
/// открыть чью-то ссылку.
///
/// «База» — маленькая модель нужных таблиц: тест спрашивает её о результате
/// (есть ли рефери, сколько начислено), а не о тексте SQL.

const SLUG = 'abc12345';
const LEADER = { id: 'L-1', slug: SLUG, user_phone: 'leader-1', name: 'Лидер', is_active: true };

class FakeDb {
  /** internal_id → welcome_bonus_at (момент рождения аккаунта) */
  users = new Map<string, Date | null>();
  profiles = new Set<string>();
  referees = new Map<string, { leader_id: string; bonus_tokens: number }>();
  credits: Array<{ userId: string; amount: number }> = [];

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM referral_leaders WHERE slug')) {
      return { rows: params[0] === SLUG ? [LEADER] : [] };
    }
    if (s.startsWith('SELECT id FROM referral_referees')) {
      return { rows: this.referees.has(params[0]) ? [{ id: 'r' }] : [] };
    }
    if (/FROM user_id/.test(s)) {
      if (!this.users.has(params[0])) return { rows: [] };
      return { rows: [{ welcome_bonus_at: this.users.get(params[0]) }] };
    }
    if (s.startsWith('INSERT INTO referral_referees')) {
      if (this.referees.has(params[0])) return { rows: [] };
      this.referees.set(params[0], { leader_id: params[1], bonus_tokens: 0 });
      return { rows: [{ id: 'r' }] };
    }
    if (s.startsWith('SELECT 1 FROM ai_profiles_consolidated')) {
      const has = this.profiles.has(params[0]);
      return { rows: has ? [{}] : [], rowCount: has ? 1 : 0 };
    }
    if (/add_user_tokens/.test(s)) {
      this.credits.push({ userId: params[0], amount: Number(params[1]) });
      return { rows: [{ res: { success: true, new_balance: Number(params[1]) } }] };
    }
    if (s.startsWith('UPDATE referral_referees SET bonus_tokens')) {
      const r = this.referees.get(params[1]);
      if (r) r.bonus_tokens = Number(params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  }

  async getClient() {
    return { query: (sql: string, params?: any[]) => this.query(sql, params), release: () => undefined };
  }

  /** Аккаунт, родившийся `agoMs` назад, с профилем. */
  seed(userId: string, agoMs: number | null) {
    this.users.set(userId, agoMs == null ? null : new Date(Date.now() - agoMs));
    this.profiles.add(userId);
  }
}

describe('реферальная привязка — только новый аккаунт', () => {
  let db: FakeDb;
  let svc: ReferralService;

  beforeEach(() => {
    db = new FakeDb();
    svc = new ReferralService(db as any);
  });

  it('только что заведённый аккаунт привязывается и получает бонус', async () => {
    db.seed('u-new', 2 * 60_000);

    const res = await svc.register('u-new', SLUG);

    expect(res).toMatchObject({ success: true, bonus_tokens: 20_000 });
    expect(db.referees.get('u-new')).toMatchObject({ leader_id: LEADER.id, bonus_tokens: 20_000 });
    expect(db.credits).toEqual([{ userId: 'u-new', amount: 20_000 }]);
  });

  it('на краю окна новизны — ещё новый', async () => {
    db.seed('u-edge', REFERRAL_NEW_ACCOUNT_WINDOW_MS - 60_000);
    expect(await svc.register('u-edge', SLUG)).toMatchObject({ success: true, bonus_tokens: 20_000 });
  });

  it('давний аккаунт — отказ: ни привязки, ни бонуса', async () => {
    db.seed('u-old', 30 * 24 * 3600_000);

    const res = await svc.register('u-old', SLUG);

    expect(res.success).toBe(false);
    expect((res as any).error).toBeTruthy();
    expect(db.referees.has('u-old')).toBe(false);
    expect(db.credits).toEqual([]);
  });

  it('сразу за окном новизны — уже не новый', async () => {
    db.seed('u-late', REFERRAL_NEW_ACCOUNT_WINDOW_MS + 60_000);
    const res = await svc.register('u-late', SLUG);
    expect(res.success).toBe(false);
    expect(db.credits).toEqual([]);
  });

  it('у аккаунта нет даты рождения (старые записи) — считается давним', async () => {
    db.seed('u-legacy', null);
    expect((await svc.register('u-legacy', SLUG)).success).toBe(false);
    expect(db.credits).toEqual([]);
  });

  it('строки аккаунта нет вовсе — отказ', async () => {
    db.profiles.add('u-ghost');
    expect((await svc.register('u-ghost', SLUG)).success).toBe(false);
    expect(db.referees.has('u-ghost')).toBe(false);
  });

  it('повторная регистрация — как раньше: «Already registered», второго бонуса нет', async () => {
    db.seed('u-twice', 60_000);
    await svc.register('u-twice', SLUG);

    const again = await svc.register('u-twice', SLUG);

    expect(again).toMatchObject({ success: false, error: 'Already registered' });
    expect(db.credits).toHaveLength(1);
  });

  it('уже привязанный рефери и после окна получает прежний ответ «Already registered»', async () => {
    db.seed('u-ref', 30 * 24 * 3600_000);
    db.referees.set('u-ref', { leader_id: LEADER.id, bonus_tokens: 20_000 });
    expect(await svc.register('u-ref', SLUG)).toMatchObject({ success: false, error: 'Already registered' });
  });
});

/// Запасная привязка по источнику входа. Отдельный запрос веба на привязку
/// иногда обрывается (страница уходит сразу после входа), а источник
/// `referral:<slug>` при этом доходит — с keepalive. Сервис ловит его крючком
/// аналитики и привязывает тем же register(): все его правила (только новый
/// аккаунт, без самоприглашения, без второго бонуса) действуют и здесь.
class FakeEvents {
  hooks: Array<(userId: string, source: string) => Promise<void>> = [];
  onAttribution(hook: (userId: string, source: string) => Promise<void>) { this.hooks.push(hook); }
  track() { /* no-op */ }
  async fire(userId: string, source: string) { for (const h of this.hooks) await h(userId, source); }
}

describe('запасная привязка по источнику входа', () => {
  let db: FakeDb;
  let events: FakeEvents;
  let svc: ReferralService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    db = new FakeDb();
    events = new FakeEvents();
    svc = new ReferralService(db as any, events as any);
    warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  });

  it('новый аккаунт с источником referral:<slug> привязывается и получает бонус', async () => {
    db.seed('u-new', 60_000);

    await events.fire('u-new', `referral:${SLUG}`);

    expect(db.referees.get('u-new')).toMatchObject({ leader_id: LEADER.id, bonus_tokens: 20_000 });
    expect(db.credits).toEqual([{ userId: 'u-new', amount: 20_000 }]);
  });

  it('нереферальный источник — ничего', async () => {
    db.seed('u-utm', 60_000);

    await events.fire('u-utm', 'utm:yandex/cpc');

    expect(db.referees.has('u-utm')).toBe(false);
    expect(db.credits).toEqual([]);
  });

  it('веб уже привязал — второго бонуса нет, в логе тихо', async () => {
    db.seed('u-web', 60_000);
    await svc.register('u-web', SLUG);

    await events.fire('u-web', `referral:${SLUG}`);

    expect(db.credits).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('давний аккаунт со старой меткой — без привязки и без шума в логе', async () => {
    db.seed('u-old', 30 * 24 * 3600_000);

    await events.fire('u-old', `referral:${SLUG}`);

    expect(db.referees.has('u-old')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('новый аккаунт и мёртвая ссылка — предупреждение в логе', async () => {
    db.seed('u-dead', 60_000);

    await events.fire('u-dead', 'referral:nosuchslug');

    expect(db.referees.has('u-dead')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nosuchslug'));
  });
});
