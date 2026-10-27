import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { IdentityService } from './identity.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

// Своя схема, а не public: в public базы спеков живёт копия tg_user_identities
// соседних pg-спеков продуктов (provisioning.rekey-purge и др.), и их TRUNCATE
// не должен задевать эти строки — как и наши строки их.
const SCHEMA = `tg_unlink_spec_${process.pid}`;

const A = 'u-unlink-a';
const B = 'u-unlink-b';
const TG = '111111111';
const TG_OTHER = '222222222';
const TG_B = '333333333';
const GROUP = '-1001111111111';

maybe('отвязка способа входа против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let svc: IdentityService;

  async function identity(userId: string, provider: string, sub: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub) VALUES ($1, $2, $3) RETURNING id`,
      [userId, provider, sub],
    );
    return r.rows[0].id;
  }
  const tgLink = (userId: string, tgUserId: string) =>
    pool.query(`INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id) VALUES ($1, $2)`, [userId, tgUserId]);
  async function config(ownerId: string, chatId: string, status = 'active'): Promise<string> {
    const r = await pool.query(
      `INSERT INTO tg_bot_configs (owner_user_id, tg_chat_id, display_name, preset_agent_id,
                                   addressing_mode, voice_reply_mode, status)
       VALUES ($1, $2, 'Linkeon', '12', 'always', 'mirror', $3) RETURNING id`,
      [ownerId, chatId, status],
    );
    return r.rows[0].id;
  }
  const identitiesOf = async (userId: string) =>
    (await pool.query(`SELECT provider, provider_sub FROM user_identities WHERE user_id = $1 ORDER BY provider`, [userId])).rows;
  const tgRows = async () =>
    (await pool.query(`SELECT linkeon_user_id, tg_user_id::text AS tg FROM tg_user_identities ORDER BY linkeon_user_id`)).rows;
  const configOf = async (id: string) =>
    (await pool.query(`SELECT status, archived_at FROM tg_bot_configs WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    // user_identities — как в identity/migrations/001_identity_init.sql, без
    // внешнего ключа на user_id (таблицы аккаунтов здесь нет).
    await pool.query(`CREATE TABLE user_identities (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        text NOT NULL,
      provider       text NOT NULL CHECK (provider IN ('phone','email','google','yandex','talerid','apple','telegram')),
      provider_sub   text NOT NULL,
      email          text,
      email_verified boolean NOT NULL DEFAULT false,
      created_at     timestamptz DEFAULT now(),
      last_used_at   timestamptz,
      UNIQUE(provider, provider_sub))`);
    // Таблицы бота — настоящим файлом схемы: колонки, проверки и частичный
    // уникальный индекс idx_tg_bot_configs_active_chat те же, что на проде.
    await pool.query(
      fs.readFileSync(path.join(__dirname, '..', 'tg-bot', 'migrations', '001_tg_bot_schema.sql'), 'utf8'),
    );
    svc = new IdentityService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE user_identities, tg_user_identities, tg_bot_configs CASCADE');
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('telegram: снимаются обе связки и архивируется личка этого Telegram; группа и чужое не тронуты', async () => {
    await identity(A, 'phone', '70000000000');
    const tgId = await identity(A, 'telegram', TG);
    await tgLink(A, TG);
    const priv = await config(A, TG);
    const group = await config(A, GROUP);
    await identity(B, 'telegram', TG_B);
    await identity(B, 'email', 'b@example.com');
    await tgLink(B, TG_B);
    const privB = await config(B, TG_B);

    expect(await svc.unlinkMethod(A, tgId)).toEqual({ ok: true });

    expect(await identitiesOf(A)).toEqual([{ provider: 'phone', provider_sub: '70000000000' }]);
    expect(await tgRows()).toEqual([{ linkeon_user_id: B, tg: TG_B }]);
    const p = await configOf(priv);
    expect(p.status).toBe('archived');
    expect(p.archived_at).not.toBeNull();
    expect(await configOf(group)).toMatchObject({ status: 'active', archived_at: null });
    expect(await configOf(privB)).toMatchObject({ status: 'active', archived_at: null });
    expect(await identitiesOf(B)).toHaveLength(2);
  });

  it('заглушённая личка этого Telegram тоже архивируется; уже архивная остаётся как была', async () => {
    await identity(A, 'phone', '70000000000');
    const tgId = await identity(A, 'telegram', TG);
    await tgLink(A, TG);
    const old = await config(A, TG, 'archived');
    await pool.query(`UPDATE tg_bot_configs SET archived_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [old]);
    const silent = await config(A, TG, 'silent');

    expect(await svc.unlinkMethod(A, tgId)).toEqual({ ok: true });

    expect((await configOf(silent)).status).toBe('archived');
    expect((await configOf(old)).archived_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('связка бота разошлась (бот привязан к другому Telegram) — строку бота и её личку не трогаем', async () => {
    await identity(A, 'phone', '70000000000');
    const tgId = await identity(A, 'telegram', TG);
    await tgLink(A, TG_OTHER);
    const otherPriv = await config(A, TG_OTHER);

    expect(await svc.unlinkMethod(A, tgId)).toEqual({ ok: true });

    expect(await identitiesOf(A)).toEqual([{ provider: 'phone', provider_sub: '70000000000' }]);
    expect(await tgRows()).toEqual([{ linkeon_user_id: A, tg: TG_OTHER }]);
    expect(await configOf(otherPriv)).toMatchObject({ status: 'active', archived_at: null });
  });

  it('тот же Telegram у бота привязан к ДРУГОМУ аккаунту — его строка и его личка целы', async () => {
    await identity(A, 'phone', '70000000000');
    const tgId = await identity(A, 'telegram', TG);
    await tgLink(B, TG);
    const privB = await config(B, TG);

    expect(await svc.unlinkMethod(A, tgId)).toEqual({ ok: true });

    expect(await identitiesOf(A)).toEqual([{ provider: 'phone', provider_sub: '70000000000' }]);
    expect(await tgRows()).toEqual([{ linkeon_user_id: B, tg: TG }]);
    expect(await configOf(privB)).toMatchObject({ status: 'active', archived_at: null });
  });

  it.each([
    ['google', 'g-sub-1'],
    ['email', 'a@example.com'],
  ])('%s: связка бота и конфиги не трогаются', async (provider, sub) => {
    await identity(A, 'phone', '70000000000');
    await identity(A, 'telegram', TG);
    const otherId = await identity(A, provider, sub);
    await tgLink(A, TG);
    const priv = await config(A, TG);

    expect(await svc.unlinkMethod(A, otherId)).toEqual({ ok: true });

    expect(await identitiesOf(A)).toEqual([
      { provider: 'phone', provider_sub: '70000000000' },
      { provider: 'telegram', provider_sub: TG },
    ]);
    expect(await tgRows()).toEqual([{ linkeon_user_id: A, tg: TG }]);
    expect(await configOf(priv)).toMatchObject({ status: 'active', archived_at: null });
  });

  it('последний способ входа — отказ, ничего не удалено и не архивировано', async () => {
    const tgId = await identity(A, 'telegram', TG);
    await tgLink(A, TG);
    const priv = await config(A, TG);

    expect(await svc.unlinkMethod(A, tgId)).toEqual({ ok: false, reason: 'last_method' });

    expect(await identitiesOf(A)).toEqual([{ provider: 'telegram', provider_sub: TG }]);
    expect(await tgRows()).toEqual([{ linkeon_user_id: A, tg: TG }]);
    expect(await configOf(priv)).toMatchObject({ status: 'active', archived_at: null });
  });

  it('чужой id способа входа — ничего не удалено ни у кого (ответ прежний)', async () => {
    await identity(A, 'phone', '70000000000');
    await identity(A, 'email', 'a@example.com');
    await identity(B, 'email', 'b@example.com');
    const tgB = await identity(B, 'telegram', TG_B);
    await tgLink(B, TG_B);
    const privB = await config(B, TG_B);

    expect(await svc.unlinkMethod(A, tgB)).toEqual({ ok: true });

    expect(await identitiesOf(A)).toHaveLength(2);
    expect(await identitiesOf(B)).toEqual([
      { provider: 'email', provider_sub: 'b@example.com' },
      { provider: 'telegram', provider_sub: TG_B },
    ]);
    expect(await tgRows()).toEqual([{ linkeon_user_id: B, tg: TG_B }]);
    expect(await configOf(privB)).toMatchObject({ status: 'active', archived_at: null });
  });
});
