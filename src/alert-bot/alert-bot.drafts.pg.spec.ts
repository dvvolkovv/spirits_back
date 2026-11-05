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
import { AlertBotService } from './alert-bot.service';
import { AlertBotTurns } from './alert-bot.turns';
import { AlertBotStore } from './alert-bot.store';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_bot_drafts_spec_${process.pid}`;
const CHAT = '-100123';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

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

  async function newTicket(): Promise<string> {
    const r = await pool.query(
      "INSERT INTO support_tickets (user_id, status) VALUES ('u-owner', 'escalated') RETURNING id",
    );
    return r.rows[0].id;
  }

  async function newDraft(ticketId: string, text = 'ответ после восстановления'): Promise<string> {
    return store.createDraft({
      chatId: CHAT,
      tgUserId: '111',
      adminUserId: 'u-admin',
      ticketId,
      text,
      promptMessageId: 900,
    });
  }

  function callback(
    draftId: string,
    action: 'send' | 'ask' | 'cancel' = 'send',
    callbackId = 'callback-recovery',
  ) {
    return {
      callbackId,
      chatId: CHAT,
      tgUserId: '111',
      adminUserId: 'u-admin',
      draftId,
      action,
      messageId: 900,
    };
  }

  async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('condition was not reached');
  }

  async function oldPublishWaitsOnTicketLock(): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const r = await pool.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE '%SELECT status FROM support_tickets%FOR UPDATE%'
         LIMIT 1`,
      );
      if (r.rows[0]) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

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

  it.each(['cancel', 'ask'] as const)(
    'publish → crash → lease expiry → %s сохраняет уже видимый ответ как sent',
    async (action) => {
      const ticketId = await newTicket();
      const draftId = await newDraft(ticketId);
      const firstClaim = await store.claimDraft(draftId, 'sending');
      if (firstClaim.status !== 'claimed') throw new Error('first claim failed');
      await support.postOwnerReplyFromTelegram(
        ticketId, '111', 'u-admin', 'ответ после восстановления', true, 'u-admin', draftId, firstClaim.version,
      );
      // Сбой после COMMIT публикации, но до finalize: transitional claim остаётся
      // в БД до истечения lease, затем его забирает другое действие админа.
      await pool.query(
        "UPDATE alert_bot_ticket_drafts SET claimed_at = now() - interval '61 seconds' WHERE id = $1",
        [draftId],
      );

      const result = await drafts.handleCallback(callback(draftId, action, `recovered-${action}`));

      expect(result).toEqual({});
      expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'sent', claimVersion: 2 });
      const effects = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM support_messages
             WHERE ticket_id = $1 AND metadata->>'alertBotDraftId' = $2) AS messages,
           (SELECT count(*)::int FROM support_events
             WHERE ticket_id = $1 AND action = 'reply') AS events`,
        [ticketId, draftId],
      );
      expect(effects.rows[0]).toEqual({ messages: 1, events: 1 });
      expect(email).toHaveBeenCalledTimes(1);
      expect(telegram.answerCallbackQuery).toHaveBeenCalledWith(`recovered-${action}`, 'Ответ уже отправлен');
      if (action === 'cancel') {
        expect(telegram.editMessageText).toHaveBeenCalledWith(CHAT, 900, '✅ Отправлено');
      } else {
        expect(telegram.editMessageText).not.toHaveBeenCalled();
      }
    },
  );

  it('claim_version ограждает старый send от нового cancel после lease expiry', async () => {
    const ticketId = await newTicket();
    const draftId = await newDraft(ticketId, 'старый ответ');
    const blocker = await pool.connect();
    let oldCallback: Promise<unknown> | null = null;
    let lockObserved = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT status FROM support_tickets WHERE id = $1 FOR UPDATE', [ticketId]);
      oldCallback = drafts.handleCallback(callback(draftId, 'send', 'old-send'));
      lockObserved = await oldPublishWaitsOnTicketLock();

      await pool.query(
        `UPDATE alert_bot_ticket_drafts
         SET claimed_at = now() - interval '61 seconds'
         WHERE id = $1 AND claim_version = 1`,
        [draftId],
      );
      await drafts.handleCallback(callback(draftId, 'cancel', 'new-cancel'));
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    await oldCallback;

    expect(lockObserved).toBe(true);
    expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'cancelled', claimVersion: 2 });
    const effects = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM support_messages WHERE ticket_id = $1) AS messages,
         (SELECT count(*)::int FROM support_events WHERE ticket_id = $1 AND action = 'reply') AS events`,
      [ticketId],
    );
    expect(effects.rows[0]).toEqual({ messages: 0, events: 0 });
    expect(email).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('old-send', 'Не удалось обработать черновик');
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('new-cancel', 'Отменено');
  });

  it('retry находит публикацию за пределами первых 500 сообщений и финализирует sent после закрытия', async () => {
    const ticketId = await newTicket();
    const draftId = await newDraft(ticketId, 'ответ за пределами preview');
    const firstClaim = await store.claimDraft(draftId, 'sending');
    if (firstClaim.status !== 'claimed') throw new Error('first claim failed');
    await support.postOwnerReplyFromTelegram(
      ticketId, '111', 'u-admin', 'ответ за пределами preview', true, 'u-admin', draftId, firstClaim.version,
    );
    await pool.query(
      `INSERT INTO support_messages
         (ticket_id, sender_type, sender_id, content, visible_to_user, created_at)
       SELECT $1, 'user', 'u-owner', 'older ' || g, true,
              now() - interval '1 day' + g * interval '1 second'
       FROM generate_series(1, 501) AS g`,
      [ticketId],
    );
    await pool.query("UPDATE support_tickets SET status = 'closed' WHERE id = $1", [ticketId]);
    await pool.query(
      "UPDATE alert_bot_ticket_drafts SET claimed_at = now() - interval '61 seconds' WHERE id = $1",
      [draftId],
    );

    await drafts.handleCallback(callback(draftId, 'send', 'retry-after-500'));

    expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'sent', claimVersion: 2 });
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('retry-after-500', 'Отправлено');
    expect(email).toHaveBeenCalledTimes(1);
    const tagged = await pool.query(
      "SELECT count(*)::int AS count FROM support_messages WHERE ticket_id = $1 AND metadata->>'alertBotDraftId' = $2",
      [ticketId, draftId],
    );
    expect(tagged.rows[0].count).toBe(1);

    const newDraftId = await newDraft(ticketId, 'новый ответ в закрытый тикет');
    await drafts.handleCallback(callback(newDraftId, 'send', 'new-closed-draft'));
    expect((await store.getDraft(newDraftId))?.outcome).toBe('cancelled');
    expect(telegram.answerCallbackQuery.mock.calls[telegram.answerCallbackQuery.mock.calls.length - 1][1]).toContain('закрыт');
    expect(email).toHaveBeenCalledTimes(1);
  });

  it('новый экземпляр Drafts восстанавливает заброшенный asking после restart и lease expiry', async () => {
    const ticketId = await newTicket();
    const draftId = await newDraft(ticketId, 'вопрос после restart');
    const localTelegram = {
      editMessageText: jest.fn().mockResolvedValue(undefined),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
    };
    const beforeRestart = new AlertBotDrafts(store, support, localTelegram as any);

    await expect(beforeRestart.handleCallback(callback(draftId, 'ask', 'before-restart')))
      .resolves.toEqual({
        question: 'вопрос после restart', ticketId, draftId, claimVersion: 1,
      });
    await pool.query(
      "UPDATE alert_bot_ticket_drafts SET claimed_at = now() - interval '61 seconds' WHERE id = $1",
      [draftId],
    );

    const afterRestart = new AlertBotDrafts(store, support, localTelegram as any);
    const recovered = await afterRestart.handleCallback(callback(draftId, 'ask', 'after-restart'));

    expect(recovered).toEqual({
      question: 'вопрос после restart', ticketId, draftId, claimVersion: 2,
    });
    expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'asking', claimVersion: 2 });
    await afterRestart.releaseAsk(draftId, 2);
  });

  it('queued asking переживает два lease expiry без новых версий, busy и повторной модели', async () => {
    const ticketId = await newTicket();
    const draftId = await newDraft(ticketId, 'вопрос из черновика');
    const previousChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_CHAT_ID = CHAT;
    const localTelegram = {
      getMe: jest.fn().mockResolvedValue({ id: 999, username: 'linkeon_alert_bot' }),
      sendMessage: jest.fn()
        .mockResolvedValueOnce({ message_id: 201 })
        .mockResolvedValueOnce({ message_id: 202 }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
      sendChunks: jest.fn().mockImplementation(
        async (_chatId: string, _text: string, firstMessageId: number) => [firstMessageId],
      ),
    };
    const localDrafts = new AlertBotDrafts(store, support, localTelegram as any);
    const blockerStarted = deferred<void>();
    const blockerAnswer = deferred<{ text: string; sessionId: string | null }>();
    const ai = {
      answer: jest.fn()
        .mockImplementationOnce(async () => {
          blockerStarted.resolve(undefined);
          return blockerAnswer.promise;
        })
        .mockResolvedValueOnce({ text: 'ответ из черновика', sessionId: null }),
    };
    const status = {
      begin: jest.fn().mockResolvedValue('status'),
      typing: jest.fn().mockResolvedValue('typing'),
      end: jest.fn().mockResolvedValue(undefined),
    };
    const chat = { begin: jest.fn(), end: jest.fn().mockResolvedValue(undefined) };
    const turns = new AlertBotTurns(store, ai as any, localTelegram as any, status as any, chat as any, support);
    const service = new AlertBotService(
      { resolveTelegram: jest.fn().mockResolvedValue({ userId: 'u-admin', isAdmin: true }) } as any,
      localTelegram as any,
      store,
      {} as any,
      localDrafts,
      turns,
      support,
    );
    const update = (updateId: number, callbackId: string) => ({
      update_id: updateId,
      callback_query: {
        id: callbackId,
        from: { id: 111 },
        data: `draft:${draftId}:ask`,
        message: {
          message_id: 900,
          chat: { id: Number(CHAT), type: 'supergroup' },
        },
      },
    });
    const callbacks: Array<Promise<void>> = [];
    const blockerTurn = turns.enqueue({
      updateId: 7100,
      chatId: CHAT,
      tgUserId: '111',
      adminUserId: 'u-admin',
      questionMessageId: 800,
      question: 'блокирующий вопрос',
      privateChat: false,
    });

    try {
      await blockerStarted.promise;
      callbacks.push(service.handleUpdate(update(7101, 'first')));
      await waitUntil(() => localTelegram.answerCallbackQuery.mock.calls.some(([id]) => id === 'first'));
      expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'asking', claimVersion: 1 });

      for (const [index, callbackId] of ['second', 'third'].entries()) {
        await pool.query(
          "UPDATE alert_bot_ticket_drafts SET claimed_at = now() - interval '61 seconds' WHERE id = $1",
          [draftId],
        );
        callbacks.push(service.handleUpdate(update(7102 + index, callbackId)));
        await waitUntil(() => localTelegram.answerCallbackQuery.mock.calls.some(([id]) => id === callbackId));
        expect(localTelegram.answerCallbackQuery).toHaveBeenCalledWith(
          callbackId, 'Черновик уже обрабатывается',
        );
        expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'asking', claimVersion: 1 });
        expect(ai.answer).toHaveBeenCalledTimes(1);
      }
    } finally {
      blockerAnswer.resolve({ text: 'ответ блокирующего вопроса', sessionId: null });
      await blockerTurn;
      await Promise.all(callbacks);
      await turns.idle();
      if (previousChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
      else process.env.TELEGRAM_CHAT_ID = previousChat;
    }

    expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'asked', claimVersion: 1 });
    expect(ai.answer).toHaveBeenCalledTimes(2);
    expect(ai.answer.mock.calls.filter(([input]) => input.question === 'вопрос из черновика')).toHaveLength(1);
    const draftTurns = await pool.query(
      "SELECT status FROM alert_bot_turns WHERE question = 'вопрос из черновика'",
    );
    expect(draftTurns.rows).toEqual([{ status: 'ok' }]);
  });
});
