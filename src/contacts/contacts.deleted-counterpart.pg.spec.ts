import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { coreTableDdl } from '../base/core-schema-ddl.forspec';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

/**
 * K6 — contacts не выдаёт живому пользователю телефон удалённого аккаунта.
 *
 * Найдено в K5: висящая заявка удалённого остаётся pending, и если живой
 * партнёр её одобрит, resolve(..., 'approved') вернёт ему requester_phone —
 * телефон удалённого (явный DELETE — живой путь прода). Гейт стоит в самом
 * SQL одобрения и выдачи телефона: заявка неактивного отправителя
 * (state <> 'active') не одобряется, телефон неактивного не выдаётся.
 * Ответ живому партнёру — тот же, что на «заявка не найдена / уже
 * обработана»: 404 { error: 'not_found_or_not_pending' }.
 *
 * Уже открытые контакты (approved до удаления) и публичный профиль: телефон
 * удалённого (state='deleted') живому пользователю больше не выдаётся —
 * строки истории остаются, номер нет. Маскируется именно удалённый: у
 * заблокированного модерацией и легаси-аккаунтов поведение прежнее.
 *
 * Схема — настоящие DDL: user_id / ai_profiles_consolidated /
 * contact_requests из снимка 001_core_schema.sql (core-schema-ddl.forspec.ts),
 * миграции account-deletion и peer (списки и профиль читают
 * peer_conversations/user_blocks). Своя схема на спеку.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `contacts_deleted_cp_spec_${process.pid}`;
const ACCOUNT_DELETION_MIGRATION = path.join(
  __dirname, '..', 'account-deletion', 'migrations', '001_account_deletion.sql',
);
const PEER_MIGRATION = path.join(__dirname, '..', 'peer', 'migrations', '001_peer_tables.sql');

// Синтетические номера (публичный репозиторий).
const DELETED = '79990000641';
const PARTNER = '79990000642';
const LIVE = '79990000643';
const BLOCKED = '79990000644';
const DELETION_ID = '8c7b6a59-4e3d-4c2b-9a1f-0e9d8c7b6a50';

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (status: number) => {
    res.statusCode = status;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
}

maybe('contacts: телефон неактивного отправителя не выдаётся (K6, PG)', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  const ids: Record<string, number> = {};

  const pgShim = () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params) });

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    return (await pool.query(sql, params)).rows;
  }

  async function seedUser(phone: string, state: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_phone, state, deleted_at, deletion_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        phone,
        phone,
        state,
        state === 'deleted' ? new Date('2026-11-01T00:00:00Z') : null,
        state === 'deleted' ? DELETION_ID : null,
      ],
    );
    const r = await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, profile_data) VALUES ($1, '{}'::jsonb) RETURNING id`,
      [phone],
    );
    ids[phone] = r.rows[0].id;
  }

  async function seedPending(from: string, to: string, message: string): Promise<number> {
    const r = await pool.query(
      `INSERT INTO contact_requests (requester_id, target_id, message, status)
       VALUES ($1,$2,$3,'pending') RETURNING id`,
      [ids[from], ids[to], message],
    );
    return r.rows[0].id;
  }

  async function requestRow(id: number): Promise<any> {
    return (await rows(
      `SELECT status, resolved_at, message FROM contact_requests WHERE id=$1`,
      [id],
    ))[0];
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    await pool.query(coreTableDdl(['user_id', 'ai_profiles_consolidated', 'contact_requests']));
    await pool.query(fs.readFileSync(ACCOUNT_DELETION_MIGRATION, 'utf8'));
    await pool.query(fs.readFileSync(PEER_MIGRATION, 'utf8'));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE contact_requests, ai_profiles_consolidated, user_id, peer_conversations,
                user_blocks RESTART IDENTITY CASCADE`,
    );
    for (const key of Object.keys(ids)) delete ids[key];
    await seedUser(DELETED, 'deleted');
    await seedUser(PARTNER, 'active');
    await seedUser(LIVE, 'active');
    await seedUser(BLOCKED, 'blocked');
  });

  describe('resolve(…, approved)', () => {
    it('удалённый отправитель: заявка не одобряется, телефона нет, ответ — 404 «не найдена или не pending»', async () => {
      const id = await seedPending(DELETED, PARTNER, 'привет от удалённого');
      const service = new ContactsService(pgShim() as any, undefined as any);

      const resolved = await service.resolve(PARTNER, id, 'approved');

      expect(resolved).toBeNull();
      expect(await requestRow(id)).toMatchObject({ status: 'pending', resolved_at: null });

      // Тот же отказ через контроллер — форма «не найдена / уже обработана».
      const res = mockRes();
      await new ContactsController(service).resolve({ userId: PARTNER }, String(id), 'approve', res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'not_found_or_not_pending' });
      expect(JSON.stringify(res.body)).not.toContain(DELETED);
      expect((await requestRow(id)).status).toBe('pending');
    });

    it('заблокированный отправитель (не active) — тоже не одобряется', async () => {
      const id = await seedPending(BLOCKED, PARTNER, 'привет');
      const service = new ContactsService(pgShim() as any, undefined as any);

      await expect(service.resolve(PARTNER, id, 'approved')).resolves.toBeNull();
      expect((await requestRow(id)).status).toBe('pending');
    });

    it('отправителя удалили между одобрением и выдачей телефона — телефон не выдаётся', async () => {
      const id = await seedPending(LIVE, PARTNER, 'привет');
      // Удаление коммитится сразу после UPDATE одобрения, до чтения телефона.
      const racing = {
        query: async (sql: string, params?: any[]) => {
          const result = await pool.query(sql, params);
          if (/^\s*UPDATE contact_requests/.test(sql)) {
            await pool.query(
              `UPDATE user_id SET state='deleted', deleted_at=now(), deletion_id=gen_random_uuid()
                WHERE internal_id=$1`,
              [LIVE],
            );
          }
          return result;
        },
      };
      const service = new ContactsService(racing as any, undefined as any);

      const resolved = await service.resolve(PARTNER, id, 'approved');

      expect(resolved?.requester_phone ?? null).toBeNull();
      expect(JSON.stringify(resolved)).not.toContain(LIVE);
    });

    it('активный отправитель — прежнее поведение: approved и телефон отправителя', async () => {
      const id = await seedPending(LIVE, PARTNER, 'привет');
      const service = new ContactsService(pgShim() as any, undefined as any);

      const resolved = await service.resolve(PARTNER, id, 'approved');

      expect(resolved).toMatchObject({ id, status: 'approved', requester_phone: LIVE });
      expect(resolved!.resolved_at).not.toBeNull();
      expect((await requestRow(id)).status).toBe('approved');
    });

    it('чужая заявка и уже обработанная — прежний null', async () => {
      const foreign = await seedPending(LIVE, BLOCKED, 'не партнёру');
      const done = await seedPending(LIVE, PARTNER, 'привет');
      const service = new ContactsService(pgShim() as any, undefined as any);
      await service.resolve(PARTNER, done, 'approved');

      await expect(service.resolve(PARTNER, foreign, 'approved')).resolves.toBeNull();
      await expect(service.resolve(PARTNER, done, 'approved')).resolves.toBeNull();
    });
  });

  describe('resolve(…, rejected)', () => {
    it('заявку удалённого можно отклонить; телефон не выдаётся', async () => {
      const id = await seedPending(DELETED, PARTNER, 'привет от удалённого');
      const service = new ContactsService(pgShim() as any, undefined as any);

      const resolved = await service.resolve(PARTNER, id, 'rejected');

      expect(resolved).toMatchObject({ id, status: 'rejected' });
      expect(resolved).not.toHaveProperty('requester_phone');
      expect((await requestRow(id)).status).toBe('rejected');
    });

    it('активный отправитель — прежнее поведение: rejected без телефона', async () => {
      const id = await seedPending(LIVE, PARTNER, 'привет');
      const service = new ContactsService(pgShim() as any, undefined as any);

      const resolved = await service.resolve(PARTNER, id, 'rejected');

      expect(resolved).toMatchObject({ id, status: 'rejected' });
      expect(resolved).not.toHaveProperty('requester_phone');
    });
  });

  describe('уже открытые контакты и публичный профиль', () => {
    async function seedApproved(from: string, to: string): Promise<number> {
      const r = await pool.query(
        `INSERT INTO contact_requests (requester_id, target_id, message, status, resolved_at)
         VALUES ($1,$2,'старая заявка','approved', now() - interval '1 day') RETURNING id`,
        [ids[from], ids[to]],
      );
      return r.rows[0].id;
    }

    function service(): ContactsService {
      return new ContactsService(pgShim() as any, undefined as any);
    }

    it('входящие: одобренная до удаления заявка удалённого — строка есть, телефона нет', async () => {
      const id = await seedApproved(DELETED, PARTNER);

      const row = (await service().listIncoming(PARTNER)).find((x) => x.id === id);

      expect(row).toMatchObject({ id, status: 'approved' });
      expect(row).not.toHaveProperty('requester_phone');
      expect(JSON.stringify(row)).not.toContain(DELETED);
    });

    it('исходящие: одобренная удалённым заявка — строка есть, телефона нет', async () => {
      const id = await seedApproved(PARTNER, DELETED);

      const row = (await service().listOutgoing(PARTNER)).find((x) => x.id === id);

      expect(row).toMatchObject({ id, status: 'approved' });
      expect(row).not.toHaveProperty('target_phone');
      expect(JSON.stringify(row)).not.toContain(DELETED);
    });

    it('списки: служебный признак удаления наружу не уходит', async () => {
      await seedApproved(LIVE, PARTNER);
      await seedApproved(PARTNER, LIVE);

      const incoming = await service().listIncoming(PARTNER);
      const outgoing = await service().listOutgoing(PARTNER);

      for (const row of [...incoming, ...outgoing]) {
        expect(Object.keys(row).filter((key) => /deleted|state/.test(key))).toEqual([]);
      }
    });

    it('списки: активный и заблокированный контрагент — телефон как прежде', async () => {
      const live = await seedApproved(LIVE, PARTNER);
      const blocked = await seedApproved(BLOCKED, PARTNER);
      const out = await seedApproved(PARTNER, LIVE);

      const incoming = await service().listIncoming(PARTNER);
      const outgoing = await service().listOutgoing(PARTNER);

      expect(incoming.find((x) => x.id === live)).toMatchObject({ requester_phone: LIVE });
      expect(incoming.find((x) => x.id === blocked)).toMatchObject({ requester_phone: BLOCKED });
      expect(outgoing.find((x) => x.id === out)).toMatchObject({ target_phone: LIVE });
    });

    it('публичный профиль удалённого: открытый контакт телефон не раскрывает', async () => {
      await seedApproved(DELETED, PARTNER);

      const profile = await service().getPublicProfile(PARTNER, ids[DELETED]);

      expect(profile).toMatchObject({ phone: null, phoneDisclosed: false, email: null, avatar_url: null });
      expect(JSON.stringify(profile)).not.toContain(DELETED);
    });

    it('публичный профиль удалённого: переписка в peer телефон не раскрывает', async () => {
      const [a, b] = [PARTNER, DELETED].sort();
      await pool.query(`INSERT INTO peer_conversations (user_a_id, user_b_id) VALUES ($1,$2)`, [a, b]);

      const profile = await service().getPublicProfile(PARTNER, ids[DELETED]);

      expect(profile).toMatchObject({ phone: null, phoneDisclosed: false });
      expect(JSON.stringify(profile)).not.toContain(DELETED);
    });

    it('публичный профиль активного открытого контакта — телефон как прежде', async () => {
      await seedApproved(LIVE, PARTNER);

      const profile = await service().getPublicProfile(PARTNER, ids[LIVE]);

      expect(profile).toMatchObject({ phone: LIVE, phoneDisclosed: true });
    });
  });
});
