import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { TgConfigService } from './tg-config.service';

/**
 * Личка бота (ensurePrivateConfig) против живого Postgres — ради настоящего
 * частичного уникального индекса idx_tg_bot_configs_active_chat: порядок
 * «архив чужого — потом вставка» и параллельные апдейты одного чата (альбом
 * приходит пачкой) решает он, а не текст запроса.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

// Своя схема — как в identity.unlink.pg.spec.ts: public базы спеков делят
// соседние pg-спеки.
const SCHEMA = `tg_private_spec_${process.pid}`;

const A = 'u-private-a';
const B = 'u-private-b';
const CHAT = 111111111;

maybe('личка бота против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  const warns: string[] = [];
  const errors: string[] = [];

  /**
   * Сервис поверх пула. barrier — сколько вызовов должны дойти до вставки
   * конфига, прежде чем она пойдёт: так оба параллельных вызова гарантированно
   * прочитали «конфига нет» до того, как один из них его завёл.
   */
  function service(barrier = 0) {
    let waiting: Array<() => void> = [];
    const pg = {
      query: async (s: string, p?: any[]) => {
        if (barrier > 1 && s.includes('INSERT INTO tg_bot_configs')) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === barrier) {
              waiting.forEach((r) => r());
              waiting = [];
            }
          });
        }
        return pool.query(s, p);
      },
    };
    const svc = new TgConfigService(pg as any, {} as any);
    (svc as any).logger = { log: () => undefined, warn: (m: string) => warns.push(m), error: (m: string) => errors.push(m) };
    return svc;
  }
  async function config(ownerId: string, chatId: number, status = 'active'): Promise<string> {
    const r = await pool.query(
      `INSERT INTO tg_bot_configs (owner_user_id, tg_chat_id, display_name, preset_agent_id,
                                   addressing_mode, voice_reply_mode, status)
       VALUES ($1, $2, 'Linkeon', '12', 'always', 'mirror', $3) RETURNING id`,
      [ownerId, chatId, status],
    );
    return r.rows[0].id;
  }
  const rowsOfChat = async (chatId: number) =>
    (await pool.query(
      `SELECT id, owner_user_id, status, archived_at FROM tg_bot_configs WHERE tg_chat_id = $1 ORDER BY created_at, id`,
      [chatId],
    )).rows;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 6, options: `-c search_path=${SCHEMA}` });
    await pool.query(
      fs.readFileSync(path.join(__dirname, 'migrations', '001_tg_bot_schema.sql'), 'utf8'),
    );
    // Что читает ensurePrivateConfig, выбирая ассистента для новой строки.
    await pool.query(`CREATE TABLE ai_profiles_consolidated (user_id text PRIMARY KEY, preferred_agent text)`);
    await pool.query(`CREATE TABLE agents (id serial PRIMARY KEY, name text)`);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE tg_bot_configs, ai_profiles_consolidated, agents CASCADE');
    warns.length = 0;
    errors.length = 0;
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('чужой живой конфиг лички архивируется, новому владельцу заводится свой', async () => {
    const foreign = await config(A, CHAT);

    const cfg = await service().ensurePrivateConfig(B, CHAT);

    expect(cfg.owner_user_id).toBe(B);
    expect(cfg.status).toBe('active');
    const rows = await rowsOfChat(CHAT);
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.id === foreign);
    expect(old.status).toBe('archived');
    expect(old.archived_at).not.toBeNull();
    expect(rows.find((r) => r.id === cfg.id)).toMatchObject({ owner_user_id: B, status: 'active' });
    expect(warns).toHaveLength(1);
  });

  it('свой живой конфиг возвращается как есть, без новых строк', async () => {
    const mine = await config(B, CHAT);

    const cfg = await service().ensurePrivateConfig(B, CHAT);

    expect(cfg.id).toBe(mine);
    expect(await rowsOfChat(CHAT)).toHaveLength(1);
  });

  it.each([
    ['конфига нет', false],
    ['живой конфиг чужой', true],
  ])('два параллельных вызова одного владельца (%s) — оба получают один и тот же конфиг, без исключения', async (_label, foreignFirst) => {
    if (foreignFirst) await config(A, CHAT);
    const svc = service(2);

    const [x, y] = await Promise.all([svc.ensurePrivateConfig(B, CHAT), svc.ensurePrivateConfig(B, CHAT)]);

    expect(x.id).toBe(y.id);
    expect(x.owner_user_id).toBe(B);
    const live = (await rowsOfChat(CHAT)).filter((r) => r.status === 'active' || r.status === 'silent');
    expect(live).toEqual([expect.objectContaining({ id: x.id, owner_user_id: B })]);
    expect(errors).toEqual([]);
  });
});
