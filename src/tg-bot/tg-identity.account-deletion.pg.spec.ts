import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';
import { TgIdentityService } from './tg-identity.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `tg_identity_deletion_spec_${process.pid}`;
const OWNER = 'u-deleted';
const TOKEN = '00000000-0000-4000-8000-000000000001';
const ACTIVE_OWNER = 'u-active';
const ACTIVE_TOKEN = '00000000-0000-4000-8000-000000000002';
const DELETION = '11111111-1111-4111-8111-111111111111';
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

maybe('TG identity deletion mid-transaction race against PostgreSQL', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '001_tg_bot_schema.sql'), 'utf8'));
    await pool.query(`CREATE TABLE user_id (internal_id text PRIMARY KEY, state text NOT NULL, deletion_id uuid)`);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  async function seed(owner: string, token: string): Promise<void> {
    await pool.query(`INSERT INTO user_id (internal_id,state) VALUES ($1,'active')`, [owner]);
    await pool.query(
      `INSERT INTO tg_claim_tokens (token,kind,owner_user_id,expires_at)
       VALUES ($1,'auth',$2,now()+interval '15 minutes')`,
      [token, owner],
    );
  }

  function makeService(deleteAfterTokenSelect: boolean, owner: string) {
    const queries: string[] = [];
    let deleteNow = deleteAfterTokenSelect;
    const pg = {
      getClient: jest.fn(async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        (client as any).query = async (sql: string, params?: any[]) => {
          const result = await query(sql, params);
          const normalized = normalize(sql);
          queries.push(normalized);
          if (deleteNow && normalized.startsWith('SELECT owner_user_id FROM tg_claim_tokens')) {
            deleteNow = false;
            await pool.query(
              `UPDATE user_id SET state='deleted',deletion_id=$1 WHERE internal_id=$2`,
              [DELETION, owner],
            );
          }
          return result;
        };
        return client;
      }),
    };
    return { svc: new TgIdentityService(pg as any), queries };
  }

  it('active consume коммитится и содержит user lock + active predicate в обоих writes', async () => {
    await seed(ACTIVE_OWNER, ACTIVE_TOKEN);
    const { svc, queries } = makeService(false, ACTIVE_OWNER);

    await expect(svc.consumeAuthToken(ACTIVE_TOKEN, 10002, null, null)).resolves.toBe(ACTIVE_OWNER);

    const token = await pool.query(`SELECT consumed_at FROM tg_claim_tokens WHERE token=$1`, [ACTIVE_TOKEN]);
    const identity = await pool.query(`SELECT tg_user_id FROM tg_user_identities WHERE linkeon_user_id=$1`, [ACTIVE_OWNER]);
    expect(token.rows[0].consumed_at).not.toBeNull();
    expect(Number(identity.rows[0].tg_user_id)).toBe(10002);
    expect(queries.some((sql) => sql.startsWith("SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active'")
      && sql.includes('FOR UPDATE'))).toBe(true);
    const consume = queries.find((sql) => sql.startsWith('UPDATE tg_claim_tokens'))!;
    const insert = queries.find((sql) => sql.startsWith('INSERT INTO tg_user_identities'))!;
    for (const sql of [consume, insert]) {
      expect(sql).toContain('EXISTS');
      expect(sql).toContain("u.state='active'");
    }
    expect(consume).toContain('u.internal_id=t.owner_user_id');
    expect(insert).toContain('u.internal_id=$1');
  });

  it('deletion после token SELECT откатывает consume/identity и не возвращает confirmation', async () => {
    await seed(OWNER, TOKEN);
    const { svc } = makeService(true, OWNER);

    await expect(svc.consumeAuthToken(TOKEN, 10001, null, null))
      .rejects.toBeInstanceOf(BadRequestException);

    const token = await pool.query(`SELECT consumed_at FROM tg_claim_tokens WHERE token=$1`, [TOKEN]);
    const identities = await pool.query(`SELECT count(*)::int AS n FROM tg_user_identities WHERE linkeon_user_id=$1`, [OWNER]);
    expect(token.rows[0].consumed_at).toBeNull();
    expect(identities.rows[0].n).toBe(0);
  });
});
