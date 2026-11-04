jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { SupportService } from '../support/support.service';
import { AlertBotDrafts } from './alert-bot.drafts';
import { AlertBotStore } from './alert-bot.store';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_bot_drafts_spec_${process.pid}`;
const CHAT = '-100123';

maybe('callback черновика с lease против PostgreSQL', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;
  let store: AlertBotStore;
  let support: SupportService;
  let drafts: AlertBotDrafts;
  let email: jest.SpyInstance;
  const telegram = {
    editMessageText: jest.fn().mockResolvedValue(undefined),
    answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'support', 'migrations', '001_support.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'support', 'migrations', '002_support_sla.sql'), 'utf8'));
    await pool.query(`CREATE TABLE ai_profiles_consolidated (
      user_id text PRIMARY KEY, profile_data jsonb, tokens bigint,
      email text, isadmin boolean, created_at timestamptz DEFAULT now()
    )`);
    const pg = {
      query: pool.query.bind(pool),
      getClient: () => pool.connect(),
    } as any;
    store = new AlertBotStore(pg);
    await store.migrate();
    support = new SupportService(pg);
    email = jest.spyOn(support, 'notifyOwnerReplyByEmail').mockResolvedValue({ sent: true });
    drafts = new AlertBotDrafts(store, support, telegram as any);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE support_tickets CASCADE');
    await pool.query('TRUNCATE alert_bot_ticket_drafts');
    telegram.editMessageText.mockClear();
    telegram.answerCallbackQuery.mockClear();
    email.mockClear();
  });

  it('reclaim заброшенного sending публикует один ответ и финализирует sent', async () => {
    const ticket = await pool.query(
      "INSERT INTO support_tickets (user_id, status) VALUES ('u-owner', 'escalated') RETURNING id",
    );
    const ticketId = ticket.rows[0].id;
    const draftId = await store.createDraft({
      chatId: CHAT,
      tgUserId: '111',
      adminUserId: 'u-admin',
      ticketId,
      text: 'ответ после восстановления',
      promptMessageId: 900,
    });
    await pool.query(
      `UPDATE alert_bot_ticket_drafts
       SET outcome = 'sending', claimed_at = now() - interval '61 seconds'
       WHERE id = $1`,
      [draftId],
    );

    await expect(drafts.handleCallback({
      callbackId: 'callback-recovery',
      chatId: CHAT,
      tgUserId: '111',
      adminUserId: 'u-admin',
      draftId,
      action: 'send',
      messageId: 900,
    })).resolves.toEqual({});

    expect((await store.getDraft(draftId))?.outcome).toBe('sent');
    const messages = await pool.query(
      `SELECT count(*)::int AS count,
              count(*) FILTER (WHERE metadata->>'alertBotDraftId' = $2)::int AS tagged
       FROM support_messages WHERE ticket_id = $1 AND sender_type = 'owner'`,
      [ticketId, draftId],
    );
    expect(messages.rows[0]).toEqual({ count: 1, tagged: 1 });
    expect(email).toHaveBeenCalledTimes(1);
    expect(telegram.editMessageText).toHaveBeenCalledWith(CHAT, 900, '✅ Отправлено');
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-recovery', 'Отправлено');
  });
});
