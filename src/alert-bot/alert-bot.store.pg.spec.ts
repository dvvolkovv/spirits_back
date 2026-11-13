import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AlertBotStore } from './alert-bot.store';
import { AlertBotTurns } from './alert-bot.turns';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_bot_spec_${process.pid}`;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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
    store = new AlertBotStore({
      query: (text: string, params?: any[]) => pool.query(text, params),
      getClient: () => pool.connect(),
    } as any);
    await store.migrate();
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '002_alert_bot_repair.sql'), 'utf8'));
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('повторная и одновременная миграция безопасны', async () => {
    await expect(Promise.all([store.migrate(), store.migrate()])).resolves.toEqual([undefined, undefined]);
  });
  it('answer_message_ids имеет валидный GIN index для continuation lookup', async () => {
    const result = await pool.query(`
      SELECT c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = 'alert_bot_turns'
        AND c.relname = 'idx_alert_bot_turns_answer_ids_gin'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indisvalid).toBe(true);
    expect(result.rows[0].definition).toContain('USING gin');
    expect(result.rows[0].definition).toContain('answer_message_ids');
  });
  it('update_id принимается один раз', async () => {
    expect(await store.claimUpdate(1001)).toBe(true);
    expect(await store.claimUpdate(1001)).toBe(false);
  });
  it('admission advisory lock имеет реальный lock_timeout', async () => {
    const blocker = await pool.connect();
    const input = {
      updateId: 1003, chatId: '1', tgUserId: '111', adminUserId: 'u-lock-timeout',
      questionMessageId: 10, question: 'bounded admission', privateChat: true,
    };
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alert-bot:${input.adminUserId}`]);
    const admission = store.admitTurn(input, 30);
    const observed = admission.then(
      (result) => ({ status: 'accepted', result }),
      (error) => ({ status: 'rejected', error }),
    );
    try {
      const outcome = await Promise.race([
        observed,
        new Promise<{ status: string }>((resolve) => setTimeout(() => resolve({ status: 'hung' }), 1500)),
      ]);
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect((outcome as any).error).toMatchObject({ code: '55P03' });
      }
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release(true);
      await observed;
    }
  });
  it('ход даёт контекст, лимит и финальный статус', async () => {
    const id = await store.createTurn({ updateId: 1002, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 10, question: 'что горит?', privateChat: true });
    await store.attachAnswerMessage(id, 20);
    expect((await store.findTurnByAnswer('1', 20))?.id).toBe(id);
    await store.finishTurn(id, { status: 'ok', answer: 'ничего', tools: ['alerts'], durationMs: 10, costUsd: 0.01 });
    expect(await store.countRecentTurns('u-admin')).toBe(1);
    expect((await store.recentTurns('1', 3, 30))[0].answer).toBe('ничего');
  });
  it('reply_text сохраняется через createTurn, admitTurn, draft admission и system turn', async () => {
    const base = {
      chatId: 'reply-persist', tgUserId: '111', adminUserId: 'u-reply-persist',
      questionMessageId: 10, question: 'Почини', privateChat: true,
    };
    await store.createTurn({ ...base, updateId: 1080, replyText: 'create diagnosis' });
    await store.admitTurn({ ...base, updateId: 1081, replyText: 'admit diagnosis' }, 30);
    await store.recordSystemTurn({ ...base, updateId: 1082, replyText: 'system diagnosis' }, 'busy');
    const draftId = await store.createDraft({
      chatId: base.chatId, tgUserId: base.tgUserId, adminUserId: base.adminUserId,
      ticketId: '11111111-1111-4111-8111-111111111111', text: 'черновик', promptMessageId: 20,
    });
    expect(await store.claimDraft(draftId, 'asking')).toEqual({ status: 'claimed', version: 1 });
    await (store as any).admitDraftQuestion({
      draftId, claimVersion: 1,
      input: { ...base, updateId: 1083, replyText: 'draft diagnosis' }, maxPerHour: 30,
    });

    const rows = await pool.query(
      'SELECT update_id, reply_text FROM alert_bot_turns WHERE update_id = ANY($1::bigint[]) ORDER BY update_id',
      [[1080, 1081, 1082, 1083]],
    );
    expect(rows.rows).toEqual([
      { update_id: '1080', reply_text: 'create diagnosis' },
      { update_id: '1081', reply_text: 'admit diagnosis' },
      { update_id: '1082', reply_text: 'system diagnosis' },
      { update_id: '1083', reply_text: 'draft diagnosis' },
    ]);
  });

  it('сохраняет первый и все continuation ID, reply ко второму chunk находит родителя', async () => {
    const id = await store.createTurn({ updateId: 1050, chatId: 'chunks', tgUserId: '111', adminUserId: 'u-chunks', questionMessageId: 10, question: 'длинный ответ', privateChat: true });

    await store.attachAnswerMessages(id, [20, 21, 22]);

    expect((await store.findTurnByAnswer('chunks', 20))?.id).toBe(id);
    expect((await store.findTurnByAnswer('chunks', 21))?.id).toBe(id);
    expect((await store.findTurnByAnswer('chunks', 22))?.id).toBe(id);
    const row = (await pool.query('SELECT answer_message_id, answer_message_ids FROM alert_bot_turns WHERE id = $1', [id])).rows[0];
    expect(row.answer_message_id).toBe('20');
    expect(row.answer_message_ids).toEqual([20, 21, 22]);
    await store.finishTurn(id, { status: 'ok' });
  });
  it('при сбое continuation первые ID сохраняют parent для reply', async () => {
    const input = { updateId: 1055, chatId: 'partial', tgUserId: '111', adminUserId: 'u-partial', questionMessageId: 10, question: 'длинный ответ', privateChat: true };
    const telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 20 }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      sendChunks: jest.fn().mockImplementation(async (...args: any[]) => {
        await args[5]?.([20]);
        await args[5]?.([20, 21]);
        throw Object.assign(new Error('continuation failed'), { kind: 'send_failed' });
      }),
    };
    const turns = new AlertBotTurns(
      store,
      telegram as any,
      { answer: jest.fn().mockResolvedValue({ text: 'частичный ответ', costUsd: 0, tools: [] }) } as any,
      { summary: jest.fn() } as any,
      { beginStream: jest.fn(), endStream: jest.fn() } as any,
      { findTicketByPrefix: jest.fn().mockResolvedValue(null) } as any,
      { run: jest.fn(), findRepairByUpdate: jest.fn().mockResolvedValue(null) } as any,
    );

    await expect(turns.enqueue(input)).rejects.toMatchObject({ kind: 'send_failed' });

    expect((await store.findTurnByAnswer('partial', 20))?.question).toBe(input.question);
    expect((await store.findTurnByAnswer('partial', 21))?.question).toBe(input.question);
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith('partial', '🔎 Смотрю…', 10);
  });
  it('atomic draft admission завершает asked до модели и не даёт второму callback создать ход', async () => {
    const adminUserId = 'u-atomic-draft';
    const draftId = await store.createDraft({
      chatId: 'atomic', tgUserId: '111', adminUserId,
      ticketId: '11111111-1111-4111-8111-111111111111', text: 'атомарный вопрос', promptMessageId: 10,
    });
    expect(await store.claimDraft(draftId, 'asking')).toEqual({ status: 'claimed', version: 1 });
    const input = {
      updateId: 1070, chatId: 'atomic', tgUserId: '111', adminUserId,
      questionMessageId: 10, question: 'атомарный вопрос', privateChat: true,
    };
    const answer = deferred<{ text: string; costUsd: number; tools: string[] }>();
    const started = deferred();
    const ai = {
      answer: jest.fn().mockImplementation(() => {
        started.resolve();
        return answer.promise;
      }),
    };
    const telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 20 }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      sendChunks: jest.fn().mockResolvedValue([20]),
    };
    const turns = new AlertBotTurns(
      store, telegram as any, ai as any,
      { summary: jest.fn() } as any,
      { beginStream: jest.fn(), endStream: jest.fn() } as any,
      { findTicketByPrefix: jest.fn().mockResolvedValue(null) } as any,
      { run: jest.fn(), findRepairByUpdate: jest.fn().mockResolvedValue(null) } as any,
    );

    const first = (turns as any).enqueue(input, { draftId, claimVersion: 1 });
    await started.promise;
    const second = (turns as any).enqueue(
      { ...input, updateId: 1071 }, { draftId, claimVersion: 1 },
    );

    try {
      expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'asked', claimVersion: 1 });
      expect((await store.getDraft(draftId))?.resolvedAt).toBeInstanceOf(Date);
      expect(await store.claimDraft(draftId, 'asking')).toEqual({ status: 'unavailable' });
      expect(ai.answer).toHaveBeenCalledTimes(1);
    } finally {
      answer.resolve({ text: 'один ответ', costUsd: 0, tools: [] });
      await Promise.all([first, second]);
    }

    await expect(first).resolves.toBe('accepted');
    await expect(second).resolves.toBe('stale');
    const rows = await pool.query(
      `SELECT status FROM alert_bot_turns WHERE linkeon_user_id = $1 AND status <> 'busy'`,
      [adminUserId],
    );
    expect(rows.rows).toEqual([{ status: 'ok' }]);
    expect(ai.answer).toHaveBeenCalledTimes(1);
  });
  it('crash после atomic admission оставляет asked и один in_progress ход без finalize', async () => {
    const adminUserId = 'u-atomic-crash';
    const draftId = await store.createDraft({
      chatId: 'crash', tgUserId: '111', adminUserId,
      ticketId: '11111111-1111-4111-8111-111111111111', text: 'crash window', promptMessageId: 10,
    });
    expect(await store.claimDraft(draftId, 'asking')).toEqual({ status: 'claimed', version: 1 });
    const input = {
      updateId: 1080, chatId: 'crash', tgUserId: '111', adminUserId,
      questionMessageId: 10, question: 'crash window', privateChat: true,
    };

    const admitted = await (store as any).admitDraftQuestion({
      draftId, claimVersion: 1, input, maxPerHour: 30,
    });

    expect(admitted).toMatchObject({ status: 'accepted', turnId: expect.any(String) });
    expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'asked', claimVersion: 1 });
    expect((await store.getDraft(draftId))?.resolvedAt).toBeInstanceOf(Date);
    const turn = await pool.query('SELECT status FROM alert_bot_turns WHERE id = $1', [admitted.turnId]);
    expect(turn.rows).toEqual([{ status: 'in_progress' }]);
    await expect((store as any).admitDraftQuestion({
      draftId, claimVersion: 1, input: { ...input, updateId: 1081 }, maxPerHour: 30,
    })).resolves.toEqual({ status: 'stale' });
    expect(await store.claimDraft(draftId, 'asking')).toEqual({ status: 'unavailable' });
    // Состояние crash проверено выше; не оставляем его остальным recovery-тестам.
    await store.finishTurn(admitted.turnId, { status: 'interrupted', errorKind: 'restart' });
  });
  it('stale и hourly refusal атомарно сохраняют asking без нового хода', async () => {
    const adminUserId = 'u-atomic-refusal';
    const draftId = await store.createDraft({
      chatId: 'refusal', tgUserId: '111', adminUserId,
      ticketId: '11111111-1111-4111-8111-111111111111', text: 'retryable', promptMessageId: 10,
    });
    expect(await store.claimDraft(draftId, 'asking')).toEqual({ status: 'claimed', version: 1 });
    const input = {
      updateId: 1090, chatId: 'refusal', tgUserId: '111', adminUserId,
      questionMessageId: 10, question: 'retryable', privateChat: true,
    };

    await expect((store as any).admitDraftQuestion({
      draftId, claimVersion: 2, input, maxPerHour: 30,
    })).resolves.toEqual({ status: 'stale' });
    await expect((store as any).admitDraftQuestion({
      draftId, claimVersion: 1, input, maxPerHour: 0,
    })).resolves.toEqual({ status: 'rate_limited' });

    expect(await store.getDraft(draftId)).toMatchObject({
      outcome: 'asking', claimVersion: 1, resolvedAt: null,
    });
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM alert_bot_turns WHERE linkeon_user_id = $1', [adminUserId],
    )).rows[0].n).toBe(0);
  });
  it('одновременный draft admission использует общий per-admin hourly lock', async () => {
    const adminUserId = 'u-atomic-concurrent';
    const makeDraft = async (suffix: number) => {
      const id = await store.createDraft({
        chatId: 'atomic-concurrent', tgUserId: '111', adminUserId,
        ticketId: '11111111-1111-4111-8111-111111111111', text: `вопрос ${suffix}`, promptMessageId: suffix,
      });
      expect(await store.claimDraft(id, 'asking')).toEqual({ status: 'claimed', version: 1 });
      return id;
    };
    const firstDraft = await makeDraft(10);
    const secondDraft = await makeDraft(11);
    const input = {
      updateId: 1095, chatId: 'atomic-concurrent', tgUserId: '111', adminUserId,
      questionMessageId: 10, question: 'первый', privateChat: true,
    };

    const results = await Promise.all([
      (store as any).admitDraftQuestion({ draftId: firstDraft, claimVersion: 1, input, maxPerHour: 1 }),
      (store as any).admitDraftQuestion({
        draftId: secondDraft, claimVersion: 1,
        input: { ...input, updateId: 1096, questionMessageId: 11, question: 'второй' }, maxPerHour: 1,
      }),
    ]);

    expect(results.map((result: any) => result.status).sort()).toEqual(['accepted', 'rate_limited']);
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM alert_bot_turns WHERE linkeon_user_id = $1', [adminUserId],
    )).rows[0].n).toBe(1);
    const drafts = await pool.query(
      'SELECT outcome FROM alert_bot_ticket_drafts WHERE id = ANY($1::uuid[]) ORDER BY outcome',
      [[firstDraft, secondDraft]],
    );
    expect(drafts.rows).toEqual([{ outcome: 'asked' }, { outcome: 'asking' }]);
    const accepted = results.find((result: any) => result.status === 'accepted');
    await store.finishTurn(accepted.turnId, { status: 'ok' });
  });
  it('system turns сразу финальны, не тратят admission и не принимают поздний finish', async () => {
    const input = { updateId: 1060, chatId: 'system', tgUserId: '111', adminUserId: 'u-system', questionMessageId: 10, question: 'системный отказ', privateChat: true };
    const busyId = await store.recordSystemTurn(input, 'busy');
    const limitedId = await store.recordSystemTurn({ ...input, updateId: 1061 }, 'rate_limited');

    const rows = (await pool.query('SELECT id, status, finished_at FROM alert_bot_turns WHERE id = ANY($1::uuid[])', [[busyId, limitedId]])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(['busy', 'rate_limited']);
    expect(rows.every((row) => row.finished_at instanceof Date)).toBe(true);
    expect(await store.countRecentTurns('u-system')).toBe(0);
    expect(await store.finishTurn(busyId, { status: 'ok' })).toBe(false);
    const admittedId = await store.tryCreateTurn({ ...input, updateId: 1062, question: 'первый настоящий ход' }, 1);
    expect(admittedId).toEqual(expect.any(String));
    await store.finishTurn(admittedId!, { status: 'ok' });
  });
  it('цепочка реплаев идёт по parentTurnId и ограничена тремя', async () => {
    const first = await store.createTurn({ updateId: 1101, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 101, question: 'первый', privateChat: false });
    const second = await store.createTurn({ updateId: 1102, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 102, question: 'второй', parentTurnId: first, privateChat: false });
    const third = await store.createTurn({ updateId: 1103, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 103, question: 'третий', parentTurnId: second, privateChat: false });
    const fourth = await store.createTurn({ updateId: 1104, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 104, question: 'четвёртый', parentTurnId: third, privateChat: false });
    await store.finishTurn(first, { status: 'ok', answer: 'a1' });
    await store.finishTurn(second, { status: 'ok', answer: 'a2' });
    await store.finishTurn(fourth, { status: 'ok', answer: 'a4' });
    expect((await store.turnChain(fourth, 3)).map((t) => t.id)).toEqual([fourth]);
    await store.finishTurn(third, { status: 'ok', answer: 'a3' });
    expect((await store.turnChain(fourth, 3)).map((t) => t.id)).toEqual([second, third, fourth]);
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
  it('claim fencing не даёт старому release/finalize перезаписать новую версию', async () => {
    const id = await store.createDraft({ chatId: '1', tgUserId: '111', adminUserId: 'u-admin', ticketId: '11111111-1111-4111-8111-111111111111', text: 'ответ', promptMessageId: 32 });
    expect(await store.claimDraft(id, 'sending')).toEqual({ status: 'claimed', version: 1 });
    expect(await store.claimDraft(id, 'asking')).toEqual({ status: 'in_progress' });
    expect(await store.releaseDraft(id, 'sending', 0)).toBe(false);
    expect(await store.releaseDraft(id, 'asking', 1)).toBe(false);
    expect(await store.releaseDraft(id, 'sending', 1)).toBe(true);
    expect(await store.claimDraft(id, 'sending')).toEqual({ status: 'claimed', version: 2 });
    expect(await store.finalizeDraft(id, 'sending', 'sent', 1)).toBe(false);
    expect(await store.finalizeDraft(id, 'asking', 'asked', 2)).toBe(false);
    expect(await store.finalizeDraft(id, 'sending', 'sent', 2)).toBe(true);
    expect(await store.finalizeDraft(id, 'sending', 'cancelled', 2)).toBe(false);
    expect(await store.releaseDraft(id, 'sending', 2)).toBe(false);
  });
  it('просроченный и legacy lease можно reclaim, а claim_version растёт', async () => {
    const expired = await store.createDraft({ chatId: '1', tgUserId: '111', adminUserId: 'u-admin', ticketId: '11111111-1111-4111-8111-111111111111', text: 'ответ', promptMessageId: 33 });
    expect(await store.claimDraft(expired, 'sending')).toEqual({ status: 'claimed', version: 1 });
    await pool.query("UPDATE alert_bot_ticket_drafts SET claimed_at = now() - interval '61 seconds' WHERE id = $1", [expired]);

    expect(await store.claimDraft(expired, 'sending')).toEqual({ status: 'claimed', version: 2 });
    expect((await store.getDraft(expired))?.claimedAt).toBeInstanceOf(Date);
    expect((await store.getDraft(expired))?.claimVersion).toBe(2);
    expect(await store.finalizeDraft(expired, 'sending', 'sent', 2)).toBe(true);

    const legacy = await store.createDraft({ chatId: '1', tgUserId: '111', adminUserId: 'u-admin', ticketId: '11111111-1111-4111-8111-111111111111', text: 'ответ', promptMessageId: 34 });
    await pool.query("UPDATE alert_bot_ticket_drafts SET outcome = 'asking', claimed_at = NULL WHERE id = $1", [legacy]);
    expect(await store.claimDraft(legacy, 'asking')).toEqual({ status: 'claimed', version: 1 });
    expect(await store.finalizeDraft(legacy, 'asking', 'asked', 1)).toBe(true);
  });
  it('непоказанный черновик можно сразу отменить', async () => {
    const id = await store.createDraft({ chatId: '1', tgUserId: '111', adminUserId: 'u-admin', ticketId: '11111111-1111-4111-8111-111111111111', text: 'ответ' });
    expect(await store.finalizeDraft(id, null, 'cancelled', 0)).toBe(true);
    expect(await store.claimDraft(id, 'sending')).toEqual({ status: 'unavailable' });
  });
  it('журнал алертов и восстановление ходов работают', async () => {
    await store.recordAlert('1', 40, '🔥 тест');
    expect((await store.recentAlerts(24, 50))[0].text).toBe('🔥 тест');
    const id = await store.createTurn({ updateId: 1003, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 11, question: 'вопрос', privateChat: true });
    expect(await store.interruptInProgress()).toEqual([expect.objectContaining({ id, chatId: '1', questionMessageId: 11 })]);
  });
  it('прерванный ход нельзя перезаписать финальным ответом', async () => {
    const id = await store.createTurn({ updateId: 1004, chatId: '1', tgUserId: '111', adminUserId: 'u-admin', questionMessageId: 12, question: 'прерванный', privateChat: true });
    expect(await store.interruptInProgress()).toEqual([expect.objectContaining({ id })]);
    const finished = await store.finishTurn(id, { status: 'ok', answer: 'поздний ответ' });
    const row = (await pool.query('SELECT status, error_kind, answer FROM alert_bot_turns WHERE id = $1', [id])).rows[0];
    expect(finished).toBe(false);
    expect(row).toMatchObject({ status: 'interrupted', error_kind: 'restart', answer: null });
  });
  it('чистка удаляет только просроченные данные', async () => {
    await pool.query(`UPDATE alert_bot_updates SET created_at = now() - interval '8 days';
      UPDATE alert_messages SET created_at = now() - interval '31 days';
      UPDATE alert_bot_turns SET created_at = now() - interval '91 days';
      UPDATE alert_bot_ticket_drafts SET created_at = now() - interval '31 days';`);
    const pg = (store as any).pg;
    const originalQuery = pg.query;
    const cleanupQueries: Array<{ text: string; params?: any[] }> = [];
    pg.query = (text: string, params?: any[]) => {
      cleanupQueries.push({ text, params });
      return pool.query(text, params);
    };
    try {
      await store.cleanup();
    } finally {
      pg.query = originalQuery;
    }
    expect(cleanupQueries).toEqual([
      { text: `DELETE FROM alert_bot_updates
       WHERE created_at < now() - $1::interval
         AND (status = 'completed' OR (status = 'failed' AND next_retry_at IS NULL))`, params: ['7 days'] },
      { text: 'DELETE FROM alert_messages WHERE created_at < now() - $1::interval', params: ['30 days'] },
      { text: 'DELETE FROM alert_bot_ticket_drafts WHERE created_at < now() - $1::interval', params: ['30 days'] },
      { text: 'DELETE FROM alert_bot_turns WHERE created_at < now() - $1::interval', params: ['90 days'] },
    ]);
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_updates')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_messages')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_turns')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM alert_bot_ticket_drafts')).rows[0].n).toBe(0);
  });
  it('повторный старт не ждёт открытую пишущую транзакцию', async () => {
    const writer = new Pool({ connectionString: PG, max: 1, options: `-c search_path=${SCHEMA}` });
    try {
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO alert_messages (chat_id, message_id, text) VALUES ('1', 999, 'open')`);
      await expect(store.migrate()).resolves.toBeUndefined();
    } finally {
      try {
        await writer.query('ROLLBACK');
      } finally {
        await writer.end();
      }
    }
  });
  it('часовой лимит атомарен при двух одновременных входах', async () => {
    const adminUserId = 'u-concurrent-limit';
    for (let i = 0; i < 29; i++) {
      await store.createTurn({ updateId: 3000 + i, chatId: '2', tgUserId: '222', adminUserId, questionMessageId: 3000 + i, question: `старый ${i}`, privateChat: true });
    }
    const results: Array<string | null> = await Promise.all([
      (store as any).tryCreateTurn({ updateId: 3101, chatId: '2', tgUserId: '222', adminUserId, questionMessageId: 3101, question: 'первый одновременный', privateChat: true }, 30),
      (store as any).tryCreateTurn({ updateId: 3102, chatId: '2', tgUserId: '222', adminUserId, questionMessageId: 3102, question: 'второй одновременный', privateChat: true }, 30),
    ]);
    expect(results.filter((id) => id !== null)).toHaveLength(1);
    expect(results).toContain(null);
    expect(typeof results.find((id) => id !== null)).toBe('string');
    const count = await pool.query('SELECT count(*)::int AS n FROM alert_bot_turns WHERE linkeon_user_id = $1', [adminUserId]);
    expect(count.rows[0].n).toBe(30);
  });
});
