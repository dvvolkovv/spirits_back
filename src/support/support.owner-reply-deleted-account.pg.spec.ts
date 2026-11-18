jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { ConflictException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { SupportService } from './support.service';

/**
 * K3 — ответ поддержки не ложится в тикет удалённого аккаунта.
 *
 * Ответ из Telegram (postOwnerReplyFromTelegram) проверки аккаунта владельца
 * тикета не имел вовсе: после удаления ответ записывался в тикет (письмо не
 * уходило только потому, что удаление обнулило адрес). У админки проверка
 * есть, но отдельным запросом ДО транзакции — между ней и записью удаление
 * успевает пройти.
 *
 * Гейт — в самом INSERT ответа (форма K1b/Task 11: WHERE EXISTS по user_id с
 * state='active'), владелец берётся из тикета. Отказ — ConflictException
 * 'ticket owner account is not active' до любой записи: ни сообщения, ни
 * события reply, ни SLA-полей, ни письма.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `support_owner_reply_deleted_spec_${process.pid}`;
const DRAFT = '33333333-3333-4333-8333-333333333333';
const OWNER_ACTIVE = '79990000401';
const OWNER_DELETED = '79990000402';
// Второй активный: открытый тикет у пользователя один (uniq_support_tickets_active_per_user).
const OWNER_ACTIVE_2 = '79990000403';
const INACTIVE = 'ticket owner account is not active';

maybe('ответ поддержки в тикет удалённого аккаунта против PostgreSQL (K3)', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '001_support.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '002_support_sla.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'alert-bot', 'migrations', '001_alert_bot.sql'), 'utf8'));
    await pool.query(`
      CREATE TABLE user_id (
        internal_id text PRIMARY KEY,
        state text NOT NULL DEFAULT 'active',
        deleted_at timestamptz,
        deletion_id uuid
      )`);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE support_tickets CASCADE');
    await pool.query('TRUNCATE alert_bot_ticket_drafts, user_id');
    await pool.query(
      `INSERT INTO user_id (internal_id, state, deleted_at, deletion_id) VALUES
         ($1, 'active', NULL, NULL),
         ($2, 'deleted', now(), gen_random_uuid()),
         ($3, 'active', NULL, NULL)`,
      [OWNER_ACTIVE, OWNER_DELETED, OWNER_ACTIVE_2],
    );
  });

  afterEach(() => jest.restoreAllMocks());

  function makeService() {
    const service = new SupportService({
      query: pool.query.bind(pool),
      getClient: () => pool.connect(),
    } as any);
    const email = jest.spyOn(service, 'notifyOwnerReplyByEmail').mockResolvedValue({ sent: true });
    return { service, email };
  }

  async function newTicket(owner: string, status = 'escalated'): Promise<string> {
    const r = await pool.query(
      'INSERT INTO support_tickets (user_id, status) VALUES ($1, $2) RETURNING id',
      [owner, status],
    );
    return r.rows[0].id;
  }

  async function seedDraft(ticketId: string): Promise<void> {
    await pool.query(
      `INSERT INTO alert_bot_ticket_drafts
         (id, chat_id, tg_user_id, linkeon_user_id, ticket_id, text,
          outcome, claim_version, claimed_at)
       VALUES ($1, '-100123', '111', 'u-admin', $2, 'ответ из черновика',
               'sending', 1, now())`,
      [DRAFT, ticketId],
    );
  }

  /** Всё, что ответ мог бы оставить в тикете. */
  async function trace(ticketId: string) {
    const r = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM support_messages m WHERE m.ticket_id = $1) AS messages,
         (SELECT count(*)::int FROM support_events e
           WHERE e.ticket_id = $1 AND e.action = 'reply') AS reply_events,
         t.status, t.first_owner_reply_at, t.last_message_at, t.updated_at
       FROM support_tickets t WHERE t.id = $1`,
      [ticketId],
    );
    return r.rows[0];
  }

  it('Telegram без черновика: владелец удалён — отказ до записи, тикет не тронут, письма нет', async () => {
    const { service, email } = makeService();
    const ticketId = await newTicket(OWNER_DELETED);
    const before = await trace(ticketId);

    const reply = service.postOwnerReplyFromTelegram(
      ticketId, '111', 'Дмитрий', 'ответ после удаления', true, 'u-admin',
    );
    await expect(reply).rejects.toBeInstanceOf(ConflictException);
    await expect(reply).rejects.toMatchObject({ message: INACTIVE });

    expect(await trace(ticketId)).toEqual(before);
    expect(email).not.toHaveBeenCalled();
  });

  it('Telegram-черновик: владелец удалён — публикация отклонена, сообщения с draftId нет', async () => {
    const { service, email } = makeService();
    const ticketId = await newTicket(OWNER_DELETED);
    await seedDraft(ticketId);
    const before = await trace(ticketId);

    await expect(service.postOwnerReplyFromTelegram(
      ticketId, '111', 'Дмитрий', 'ответ из черновика', true, 'u-admin', DRAFT, 1,
    )).rejects.toMatchObject({ message: INACTIVE });

    expect(await trace(ticketId)).toEqual(before);
    expect(await service.findTelegramDraftPublication(ticketId, DRAFT)).toBe(false);
    expect(email).not.toHaveBeenCalled();
  });

  it('админка: удаление прошло между проверкой аккаунта и записью — запись всё равно не ложится', async () => {
    const { service, email } = makeService();
    const ticketId = await newTicket(OWNER_DELETED);
    const before = await trace(ticketId);
    // Проверка до транзакции «прошла» — так выглядит окно, в котором удаление
    // успело между ней и INSERT ответа.
    jest.spyOn(service as any, 'assertAccountActive').mockResolvedValue(undefined);

    await expect(service.adminReply(ticketId, 'u-admin', 'ответ из админки'))
      .rejects.toMatchObject({ message: INACTIVE });

    expect(await trace(ticketId)).toEqual(before);
    expect(email).not.toHaveBeenCalled();
  });

  it('активный владелец: ответ из Telegram записывается как раньше (с черновиком и без)', async () => {
    const { service, email } = makeService();
    const plain = await newTicket(OWNER_ACTIVE);
    const drafted = await newTicket(OWNER_ACTIVE_2);
    await seedDraft(drafted);

    await service.postOwnerReplyFromTelegram(plain, '111', 'Дмитрий', 'ответ', true, 'u-admin');
    await service.postOwnerReplyFromTelegram(
      drafted, '111', 'Дмитрий', 'ответ из черновика', true, 'u-admin', DRAFT, 1,
    );

    for (const id of [plain, drafted]) {
      const t = await trace(id);
      expect(t).toMatchObject({ messages: 1, reply_events: 1, status: 'owner_handling' });
      expect(t.first_owner_reply_at).not.toBeNull();
      expect(t.last_message_at).not.toBeNull();
    }
    expect(await service.findTelegramDraftPublication(drafted, DRAFT)).toBe(true);
    expect(email.mock.calls).toEqual([[plain, 'ответ'], [drafted, 'ответ из черновика']]);
  });
});
