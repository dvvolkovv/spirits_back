jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { SupportService } from './support.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `support_telegram_idempotency_spec_${process.pid}`;
const DRAFT = '22222222-2222-4222-8222-222222222222';

maybe('идемпотентная публикация Telegram-черновика против PostgreSQL', () => {
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
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE support_tickets CASCADE');
    await pool.query('TRUNCATE alert_bot_ticket_drafts');
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

  async function newTicket(status = 'escalated'): Promise<string> {
    const r = await pool.query(
      'INSERT INTO support_tickets (user_id, status) VALUES ($1, $2) RETURNING id',
      [`user-${Math.random()}`, status],
    );
    return r.rows[0].id;
  }

  async function seedDraft(ticketId: string): Promise<void> {
    await pool.query(
      `INSERT INTO alert_bot_ticket_drafts
         (id, chat_id, tg_user_id, linkeon_user_id, ticket_id, text,
          outcome, claim_version, claimed_at)
       VALUES ($1, '-100123', '111', 'u-admin', $2, 'идемпотентный ответ',
               'sending', 1, now())`,
      [DRAFT, ticketId],
    );
  }

  function publish(service: SupportService, ticketId: string): Promise<void> {
    return service.postOwnerReplyFromTelegram(
      ticketId, '111', 'Дмитрий', 'идемпотентный ответ', true, 'u-admin', DRAFT, 1,
    );
  }

  async function effects(ticketId: string) {
    const r = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM support_messages m
           WHERE m.ticket_id = $1 AND m.sender_type = 'owner') AS messages,
         (SELECT count(*)::int FROM support_events e
           WHERE e.ticket_id = $1 AND e.action = 'reply') AS events,
         (SELECT count(*)::int FROM support_messages m
           WHERE m.ticket_id = $1 AND m.metadata->>'alertBotDraftId' = $2) AS tagged,
         (SELECT status FROM support_tickets t WHERE t.id = $1) AS status,
         (SELECT first_owner_reply_at FROM support_tickets t WHERE t.id = $1) AS first_owner_reply_at,
         (SELECT min(created_at) FROM support_messages m
           WHERE m.ticket_id = $1 AND m.sender_type = 'owner') AS message_at`,
      [ticketId, DRAFT],
    );
    return r.rows[0];
  }

  it('последовательный retry не повторяет message/event/email и не трогает тикет', async () => {
    const { service, email } = makeService();
    const ticketId = await newTicket();
    await seedDraft(ticketId);

    await publish(service, ticketId);
    const first = await pool.query('SELECT updated_at FROM support_tickets WHERE id = $1', [ticketId]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await publish(service, ticketId);

    expect(await effects(ticketId)).toMatchObject({
      messages: 1,
      events: 1,
      tagged: 1,
      status: 'owner_handling',
    });
    const stored = await effects(ticketId);
    expect(stored.first_owner_reply_at).toEqual(stored.message_at);
    const second = await pool.query('SELECT updated_at FROM support_tickets WHERE id = $1', [ticketId]);
    expect(second.rows[0].updated_at).toEqual(first.rows[0].updated_at);
    expect(email).toHaveBeenCalledTimes(1);
  });

  it('два конкурентных вызова с одним draftId дают один message/event/email', async () => {
    const { service, email } = makeService();
    const ticketId = await newTicket();
    await seedDraft(ticketId);

    await Promise.all([publish(service, ticketId), publish(service, ticketId)]);

    expect(await effects(ticketId)).toMatchObject({ messages: 1, events: 1, tagged: 1 });
    expect(email).toHaveBeenCalledTimes(1);
  });

  it('publish → close → retry возвращает идемпотентный успех без новых эффектов', async () => {
    const { service, email } = makeService();
    const ticketId = await newTicket();
    await seedDraft(ticketId);

    await publish(service, ticketId);
    await pool.query("UPDATE support_tickets SET status = 'closed', updated_at = now() WHERE id = $1", [ticketId]);
    const closed = await pool.query(
      'SELECT updated_at, first_owner_reply_at FROM support_tickets WHERE id = $1',
      [ticketId],
    );

    await expect(publish(service, ticketId)).resolves.toBeUndefined();

    expect(await effects(ticketId)).toMatchObject({
      messages: 1,
      events: 1,
      tagged: 1,
      status: 'closed',
    });
    const retried = await pool.query(
      'SELECT updated_at, first_owner_reply_at FROM support_tickets WHERE id = $1',
      [ticketId],
    );
    expect(retried.rows[0]).toEqual(closed.rows[0]);
    expect(email).toHaveBeenCalledTimes(1);
  });

  it.each(['resolved', 'closed'])('терминальный тикет %s под row lock не получает visible message', async (status) => {
    const { service, email } = makeService();
    const ticketId = await newTicket(status);
    await seedDraft(ticketId);

    await expect(publish(service, ticketId)).rejects.toMatchObject({ message: 'ticket is terminal' });

    expect(await effects(ticketId)).toMatchObject({ messages: 0, events: 0, tagged: 0, status });
    expect(email).not.toHaveBeenCalled();
  });
});
