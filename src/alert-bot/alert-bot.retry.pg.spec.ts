jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AlertBotService } from './alert-bot.service';
import { AlertBotStore } from './alert-bot.store';
import { AlertBotTurns } from './alert-bot.turns';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_bot_retry_spec_${process.pid}`;

maybe('дurable retry обновлений бота алертов против PostgreSQL', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;
  let store: AlertBotStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '001_alert_bot.sql'), 'utf8'));
    store = new AlertBotStore({
      query: (text: string, params?: any[]) => pool.query(text, params),
      getClient: () => pool.connect(),
    } as any);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE alert_bot_updates, alert_bot_turns, alert_bot_ticket_drafts, alert_messages');
  });

  function makeService(telegram: Record<string, jest.Mock>, aiAnswer: jest.Mock) {
    const turns = new AlertBotTurns(
      store,
      telegram as any,
      { answer: aiAnswer } as any,
      { summary: jest.fn().mockResolvedValue('Сводка') } as any,
      { beginStream: jest.fn(), endStream: jest.fn() } as any,
      { findTicketByPrefix: jest.fn().mockResolvedValue(null) } as any,
    );
    const service = new AlertBotService(
      { resolveTelegram: jest.fn().mockResolvedValue({ isAdmin: true, userId: 'admin-retry' }) } as any,
      telegram as any,
      store,
      {
        start: jest.fn(), status: jest.fn().mockResolvedValue('Статус'), close: jest.fn(),
      } as any,
      {
        handleCallback: jest.fn(), maybeDraft: jest.fn(), releaseAsk: jest.fn(), finishAsk: jest.fn(),
      } as any,
      turns,
      { findTicketByPrefix: jest.fn().mockResolvedValue(null) } as any,
    );
    return { service, turns };
  }

  const update = {
    update_id: 91001,
    message: {
      message_id: 10,
      text: 'Что горит?',
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
    },
  };

  it('transient getMe после claim автоматически повторяется и вызывает модель ровно один раз', async () => {
    const aiAnswer = jest.fn().mockResolvedValue({ text: 'Всё спокойно', costUsd: 0, tools: [] });
    const telegram = {
      getMe: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('temporary'), { kind: 'telegram_down' }))
        .mockResolvedValue({ id: 999, username: 'linkeon_alert_bot' }),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 901 }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      sendChunks: jest.fn().mockResolvedValue([901]),
      answerCallbackQuery: jest.fn(),
    };
    const { service } = makeService(telegram, aiAnswer);

    await service.handleUpdate(update);
    expect(aiAnswer).not.toHaveBeenCalled();
    const failed = await pool.query(
      `SELECT status, attempts, payload, next_retry_at, error_kind
       FROM alert_bot_updates WHERE update_id = $1`,
      [update.update_id],
    );
    expect(failed.rows[0]).toMatchObject({
      status: 'failed', attempts: 1, error_kind: 'telegram_down', payload: update,
    });
    expect(failed.rows[0].next_retry_at).toBeInstanceOf(Date);

    await pool.query(
      'UPDATE alert_bot_updates SET next_retry_at = now() - interval \'1 second\' WHERE update_id = $1',
      [update.update_id],
    );
    await (service as any).retryFailedUpdates();

    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect(telegram.getMe).toHaveBeenCalledTimes(2);
    const completed = await pool.query(
      'SELECT status, attempts FROM alert_bot_updates WHERE update_id = $1',
      [update.update_id],
    );
    expect(completed.rows[0]).toMatchObject({ status: 'completed', attempts: 2 });
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_turns')).rows[0].n).toBe(1);

    await service.handleUpdate(update);
    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_turns')).rows[0].n).toBe(1);
  });

  it('сбой Telegram при deterministic ответе сохраняет payload и retry не создаёт модельный ход', async () => {
    const aiAnswer = jest.fn();
    const telegram = {
      getMe: jest.fn().mockResolvedValue({ id: 999, username: 'linkeon_alert_bot' }),
      sendMessage: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('temporary'), { kind: 'send_failed' }))
        .mockResolvedValue({ message_id: 902 }),
      editMessageText: jest.fn(),
      sendChunks: jest.fn(),
      answerCallbackQuery: jest.fn(),
    };
    const { service } = makeService(telegram, aiAnswer);
    const statusUpdate = {
      ...update,
      update_id: 91002,
      message: { ...update.message, text: '/status' },
    };

    await service.handleUpdate(statusUpdate);
    await pool.query(
      'UPDATE alert_bot_updates SET next_retry_at = now() - interval \'1 second\' WHERE update_id = $1',
      [statusUpdate.update_id],
    );
    await (service as any).retryFailedUpdates();

    expect(aiAnswer).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [statusUpdate.update_id],
    )).rows[0].status).toBe('completed');
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_turns')).rows[0].n).toBe(0);
  });
});
