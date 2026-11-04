import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AlertBotStore } from './alert-bot.store';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_bot_spec_${process.pid}`;

maybe('хранилище бота алертов против PostgreSQL', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;
  let store: AlertBotStore;
  const sql = () => fs.readFileSync(path.join(__dirname, 'migrations', '001_alert_bot.sql'), 'utf8');

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    store = new AlertBotStore({ query: (text: string, params?: any[]) => pool.query(text, params) } as any);
    await store.migrate();
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('повторная и одновременная миграция безопасны', async () => {
    await expect(Promise.all([store.migrate(), store.migrate()])).resolves.toEqual([undefined, undefined]);
  });
  it('update_id принимается один раз', async () => {
    expect(await store.claimUpdate(1001)).toBe(true);
    expect(await store.claimUpdate(1001)).toBe(false);
  });
  it('ход даёт контекст, лимит и финальный статус', async () => {
    const id = await store.createTurn({ updateId: 1002, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 10, question: 'что горит?', privateChat: true });
    await store.attachAnswerMessage(id, 20);
    expect((await store.findTurnByAnswer('1', 20))?.id).toBe(id);
    await store.finishTurn(id, { status: 'ok', answer: 'ничего', tools: ['alerts'], durationMs: 10, costUsd: 0.01 });
    expect(await store.countRecentTurns('u-admin')).toBe(1);
    expect((await store.recentTurns('1', 3, 30))[0].answer).toBe('ничего');
  });
  it('цепочка реплаев идёт по parentTurnId и ограничена тремя', async () => {
    const first = await store.createTurn({ updateId: 1101, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 101, question: 'первый', privateChat: false });
    const second = await store.createTurn({ updateId: 1102, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 102, question: 'второй', parentTurnId: first, privateChat: false });
    const third = await store.createTurn({ updateId: 1103, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 103, question: 'третий', parentTurnId: second, privateChat: false });
    await store.finishTurn(first, { status: 'ok', answer: 'a1' });
    await store.finishTurn(second, { status: 'ok', answer: 'a2' });
    await store.finishTurn(third, { status: 'ok', answer: 'a3' });
    expect((await store.turnChain(third, 3)).map((t) => t.id)).toEqual([first, second, third]);
  });
  it('черновик меняет состояние один раз', async () => {
    const id = await store.createDraft({ chatId: '1', tgUserId: '111', adminUserId: 'u-admin', ticketId: '11111111-1111-4111-8111-111111111111', text: 'ответ', promptMessageId: 30 });
    expect(await store.consumeDraft(id, 'sent')).toBe(true);
    expect(await store.consumeDraft(id, 'cancelled')).toBe(false);
  });
  it('просроченный черновик не принимается', async () => {
    const id = await store.createDraft({ chatId: '1', tgUserId: '111', adminUserId: 'u-admin', ticketId: '11111111-1111-4111-8111-111111111111', text: 'ответ', promptMessageId: 31 });
    await pool.query('UPDATE alert_bot_ticket_drafts SET expires_at = now() - interval \'1 second\' WHERE id = $1', [id]);
    expect(await store.consumeDraft(id, 'sent')).toBe(false);
  });
  it('журнал алертов и восстановление ходов работают', async () => {
    await store.recordAlert('1', 40, '🔥 тест');
    expect((await store.recentAlerts(24, 50))[0].text).toBe('🔥 тест');
    const id = await store.createTurn({ updateId: 1003, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 11, question: 'вопрос', privateChat: true });
    expect(await store.interruptInProgress()).toEqual([expect.objectContaining({ id, chatId: '1', questionMessageId: 11 })]);
  });
  it('чистка удаляет только просроченные данные', async () => {
    await pool.query(`UPDATE alert_bot_updates SET created_at = now() - interval '8 days';
      UPDATE alert_messages SET created_at = now() - interval '31 days';
      UPDATE alert_bot_turns SET created_at = now() - interval '91 days';
      UPDATE alert_bot_ticket_drafts SET created_at = now() - interval '31 days';`);
    await store.cleanup();
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_updates')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_messages')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_turns')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_ticket_drafts')).rows[0].n).toBe(0);
  });
  it('повторный старт не ждёт открытую пишущую транзакцию', async () => {
    const writer = new Pool({ connectionString: PG, max: 1, options: `-c search_path=${SCHEMA}` });
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO alert_messages (chat_id, message_id, text) VALUES ('1', 999, 'open')`);
    try {
      await expect(store.migrate()).resolves.toBeUndefined();
    } finally {
      await writer.query('ROLLBACK');
      await writer.end();
    }
  });
});
