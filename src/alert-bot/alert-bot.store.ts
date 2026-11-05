import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { TurnInput } from './alert-bot.types';

export type AlertBotTurnStatus =
  | 'in_progress'
  | 'ok'
  | 'model_down'
  | 'timeout'
  | 'busy'
  | 'rate_limited'
  | 'error'
  | 'interrupted';

export interface AlertBotTurn {
  id: string;
  updateId: number;
  chatId: string;
  tgUserId: string;
  adminUserId: string;
  questionMessageId: number;
  answerMessageId: number | null;
  answerMessageIds: number[];
  parentTurnId: string | null;
  question: string;
  answer: string | null;
  tools: string[];
  status: AlertBotTurnStatus;
  errorKind: string | null;
  durationMs: number | null;
  costUsd: number | null;
  modelStartedAt: Date | null;
  placeholderMessageId: number | null;
  placeholderStartedAt: Date | null;
  deliveryStartedAt: Date | null;
  deliveryCompletedAt: Date | null;
  privateChat: boolean;
  createdAt: Date;
  finishedAt: Date | null;
}

export type AlertBotDraftOutcome = 'sent' | 'cancelled' | 'asked';
export type AlertBotDraftClaim = 'sending' | 'asking' | 'cancelling';
export type AlertBotDraftClaimResult =
  | { status: 'claimed'; version: number }
  | { status: 'in_progress' | 'unavailable' };

export interface AlertBotDraft {
  id: string;
  chatId: string;
  tgUserId: string;
  adminUserId: string;
  ticketId: string;
  text: string;
  promptMessageId: number | null;
  expiresAt: Date;
  outcome: AlertBotDraftOutcome | AlertBotDraftClaim | null;
  claimedAt: Date | null;
  claimVersion: number;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface AlertMessage {
  id: number;
  chatId: string;
  messageId: number;
  text: string;
  createdAt: Date;
}

export interface DraftReservation {
  draftId: string;
  claimVersion: number;
}

export interface AdmitDraftQuestionInput extends DraftReservation {
  input: TurnInput;
  maxPerHour: number;
}

export type TurnAdmission =
  | { status: 'accepted'; turnId: string }
  | { status: 'existing'; turnId: string; turnStatus: AlertBotTurnStatus; turn: AlertBotTurn }
  | { status: 'rate_limited' };

export type DraftQuestionAdmission =
  | { status: 'accepted'; turnId: string }
  | { status: 'existing'; turnId: string; turnStatus: AlertBotTurnStatus; turn: AlertBotTurn }
  | { status: 'rate_limited' }
  | { status: 'stale' };

export interface FinishTurnResult {
  status: Exclude<AlertBotTurnStatus, 'in_progress'>;
  answer?: string;
  tools?: string[];
  errorKind?: string;
  durationMs?: number;
  costUsd?: number;
}

export interface CreateDraftInput {
  chatId: string;
  tgUserId: string;
  adminUserId: string;
  ticketId: string;
  text: string;
  promptMessageId?: number;
}

function mapTurn(row: any): AlertBotTurn {
  return {
    id: row.id,
    updateId: Number(row.update_id),
    chatId: row.chat_id,
    tgUserId: row.tg_user_id,
    adminUserId: row.linkeon_user_id,
    questionMessageId: Number(row.question_message_id),
    answerMessageId: row.answer_message_id === null ? null : Number(row.answer_message_id),
    answerMessageIds: Array.isArray(row.answer_message_ids) ? row.answer_message_ids.map(Number) : [],
    parentTurnId: row.parent_turn_id,
    question: row.question,
    answer: row.answer,
    tools: row.tools ?? [],
    status: row.status,
    errorKind: row.error_kind,
    durationMs: row.duration_ms,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    modelStartedAt: row.model_started_at,
    placeholderMessageId: row.placeholder_message_id === null ? null : Number(row.placeholder_message_id),
    placeholderStartedAt: row.placeholder_started_at,
    deliveryStartedAt: row.delivery_started_at,
    deliveryCompletedAt: row.delivery_completed_at,
    privateChat: row.private_chat,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function mapDraft(row: any): AlertBotDraft {
  return {
    id: row.id,
    chatId: row.chat_id,
    tgUserId: row.tg_user_id,
    adminUserId: row.linkeon_user_id,
    ticketId: row.ticket_id,
    text: row.text,
    promptMessageId: row.prompt_message_id === null ? null : Number(row.prompt_message_id),
    expiresAt: row.expires_at,
    outcome: row.outcome,
    claimedAt: row.claimed_at,
    claimVersion: Number(row.claim_version),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

@Injectable()
export class AlertBotStore {
  constructor(private readonly pg: PgService) {}

  async migrate(): Promise<void> {
    const candidates = [
      path.join(__dirname, 'migrations', '001_alert_bot.sql'),
      path.join(__dirname, '..', '..', 'src', 'alert-bot', 'migrations', '001_alert_bot.sql'),
    ];
    const migrationPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!migrationPath) throw new Error('alert-bot migration 001_alert_bot.sql not found');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await this.pg.query(sql);
  }

  async claimUpdate(updateId: number, payload?: unknown): Promise<boolean> {
    const inserted = await this.pg.query(
      `INSERT INTO alert_bot_updates
         (update_id, payload, status, attempts, updated_at)
       VALUES ($1, $2::jsonb,
         CASE WHEN $2::jsonb IS NULL THEN 'completed' ELSE 'processing' END, 1, now())
       ON CONFLICT (update_id) DO NOTHING RETURNING update_id`,
      [updateId, payload === undefined ? null : JSON.stringify(payload)],
    );
    if (inserted.rowCount === 1) return true;
    const reclaimed = await this.pg.query(
      `UPDATE alert_bot_updates
       SET status = 'processing', attempts = attempts + 1,
           next_retry_at = NULL, error_kind = NULL, updated_at = now()
       WHERE update_id = $1 AND status = 'failed' AND attempts < 5
         AND next_retry_at IS NOT NULL AND next_retry_at <= now()
       RETURNING update_id`,
      [updateId],
    );
    return reclaimed.rowCount === 1;
  }

  async completeUpdate(updateId: number): Promise<void> {
    await this.pg.query(
      `UPDATE alert_bot_updates
       SET status = 'completed', next_retry_at = NULL, error_kind = NULL, updated_at = now()
       WHERE update_id = $1 AND status = 'processing'`,
      [updateId],
    );
  }

  async failUpdate(updateId: number, errorKind: string): Promise<boolean> {
    const safeKind = /^[a-z][a-z0-9_.-]{0,40}$/i.test(errorKind) ? errorKind : 'error';
    const result = await this.pg.query(
      `UPDATE alert_bot_updates
       SET status = 'failed', error_kind = $2, updated_at = now(),
           next_retry_at = CASE WHEN attempts < 5
             THEN now() + (LEAST(300, POWER(2, attempts - 1))::text || ' seconds')::interval
             ELSE NULL END
       WHERE update_id = $1 AND status = 'processing'
       RETURNING attempts >= 5 AS final`,
      [updateId, safeKind],
    );
    return result.rows[0]?.final === true;
  }

  async dueUpdates(limit = 20): Promise<Array<{ updateId: number; payload: unknown }>> {
    const bounded = clampInteger(limit, 1, 100);
    const result = await this.pg.query(
      `SELECT update_id, payload FROM alert_bot_updates
       WHERE status = 'failed' AND attempts < 5 AND payload IS NOT NULL
         AND next_retry_at IS NOT NULL AND next_retry_at <= now()
       ORDER BY next_retry_at, update_id LIMIT $1`,
      [bounded],
    );
    return result.rows.map((row) => ({ updateId: Number(row.update_id), payload: row.payload }));
  }

  async requeueProcessingUpdates(staleSeconds = 0): Promise<void> {
    const bounded = clampInteger(staleSeconds, 0, 24 * 60 * 60);
    await this.pg.query(
      `UPDATE alert_bot_updates
       SET status = 'failed', next_retry_at = now(), updated_at = now()
       WHERE status = 'processing' AND payload IS NOT NULL
         AND updated_at <= now() - ($1 * interval '1 second')`,
      [bounded],
    );
  }

  async createTurn(input: TurnInput): Promise<string> {
    const r = await this.pg.query(
      `INSERT INTO alert_bot_turns
         (update_id, chat_id, tg_user_id, linkeon_user_id, question_message_id,
          parent_turn_id, question, private_chat, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress')
       RETURNING id`,
      [
        input.updateId,
        input.chatId,
        input.tgUserId,
        input.adminUserId,
        input.questionMessageId,
        input.parentTurnId ?? null,
        input.question,
        input.privateChat,
      ],
    );
    return r.rows[0].id;
  }

  async recordSystemTurn(input: TurnInput, status: 'busy' | 'rate_limited'): Promise<string> {
    if (status !== 'busy' && status !== 'rate_limited') throw new Error('invalid system turn status');
    const r = await this.pg.query(
      `INSERT INTO alert_bot_turns
         (update_id, chat_id, tg_user_id, linkeon_user_id, question_message_id,
          parent_turn_id, question, private_chat, status, error_kind, duration_ms, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, 0, now())
       ON CONFLICT (update_id) DO UPDATE SET update_id = EXCLUDED.update_id
       RETURNING id`,
      [
        input.updateId,
        input.chatId,
        input.tgUserId,
        input.adminUserId,
        input.questionMessageId,
        input.parentTurnId ?? null,
        input.question,
        input.privateChat,
        status,
      ],
    );
    return r.rows[0].id;
  }

  async admitTurn(input: TurnInput, maxPerHour: number): Promise<TurnAdmission> {
    const client = await this.pg.getClient();
    let transactionOpen = false;
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alert-bot:${input.adminUserId}`]);
      const existing = await client.query(
        `SELECT * FROM alert_bot_turns WHERE update_id = $1`,
        [input.updateId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        transactionOpen = false;
        return {
          status: 'existing',
          turnId: existing.rows[0].id,
          turnStatus: existing.rows[0].status,
          turn: mapTurn(existing.rows[0]),
        };
      }
      const count = await client.query(
        `SELECT count(*)::int AS n FROM alert_bot_turns
         WHERE linkeon_user_id = $1 AND created_at >= now() - interval '1 hour'
           AND status IN ('in_progress', 'ok', 'model_down', 'timeout', 'error', 'interrupted')`,
        [input.adminUserId],
      );
      if (count.rows[0].n >= maxPerHour) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { status: 'rate_limited' };
      }
      const r = await client.query(
        `INSERT INTO alert_bot_turns
           (update_id, chat_id, tg_user_id, linkeon_user_id, question_message_id,
            parent_turn_id, question, private_chat, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress')
         RETURNING id`,
        [
          input.updateId,
          input.chatId,
          input.tgUserId,
          input.adminUserId,
          input.questionMessageId,
          input.parentTurnId ?? null,
          input.question,
          input.privateChat,
        ],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { status: 'accepted', turnId: r.rows[0].id };
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroyClient = true;
        }
      }
      throw error;
    } finally {
      client.release(destroyClient);
    }
  }

  async tryCreateTurn(input: TurnInput, maxPerHour: number): Promise<string | null> {
    const admission = await this.admitTurn(input, maxPerHour);
    return admission.status === 'rate_limited' ? null : admission.turnId;
  }

  async admitDraftQuestion(params: AdmitDraftQuestionInput): Promise<DraftQuestionAdmission> {
    const { draftId, claimVersion, input, maxPerHour } = params;
    const client = await this.pg.getClient();
    let transactionOpen = false;
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alert-bot:${input.adminUserId}`]);
      const existing = await client.query(
        `SELECT * FROM alert_bot_turns WHERE update_id = $1`,
        [input.updateId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        transactionOpen = false;
        return {
          status: 'existing',
          turnId: existing.rows[0].id,
          turnStatus: existing.rows[0].status,
          turn: mapTurn(existing.rows[0]),
        };
      }
      const draft = await client.query(
        `SELECT id FROM alert_bot_ticket_drafts
         WHERE id = $1 AND outcome = 'asking' AND claim_version = $2
         FOR UPDATE`,
        [draftId, claimVersion],
      );
      if (!draft.rows[0]) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { status: 'stale' };
      }
      const count = await client.query(
        `SELECT count(*)::int AS n FROM alert_bot_turns
         WHERE linkeon_user_id = $1 AND created_at >= now() - interval '1 hour'
           AND status IN ('in_progress', 'ok', 'model_down', 'timeout', 'error', 'interrupted')`,
        [input.adminUserId],
      );
      if (count.rows[0].n >= maxPerHour) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { status: 'rate_limited' };
      }
      const turn = await client.query(
        `INSERT INTO alert_bot_turns
           (update_id, chat_id, tg_user_id, linkeon_user_id, question_message_id,
            parent_turn_id, question, private_chat, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress')
         RETURNING id`,
        [
          input.updateId,
          input.chatId,
          input.tgUserId,
          input.adminUserId,
          input.questionMessageId,
          input.parentTurnId ?? null,
          input.question,
          input.privateChat,
        ],
      );
      await client.query(
        `UPDATE alert_bot_ticket_drafts
         SET outcome = 'asked', claimed_at = NULL, resolved_at = now()
         WHERE id = $1 AND outcome = 'asking' AND claim_version = $2`,
        [draftId, claimVersion],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { status: 'accepted', turnId: turn.rows[0].id };
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroyClient = true;
        }
      }
      throw error;
    } finally {
      client.release(destroyClient);
    }
  }

  async attachAnswerMessage(turnId: string, messageId: number): Promise<void> {
    await this.pg.query('UPDATE alert_bot_turns SET answer_message_id = $2 WHERE id = $1', [turnId, messageId]);
  }

  async markPlaceholderStarted(turnId: string): Promise<void> {
    await this.pg.query(
      `UPDATE alert_bot_turns
       SET placeholder_started_at = COALESCE(placeholder_started_at, now())
       WHERE id = $1`,
      [turnId],
    );
  }

  async deferPlaceholder(turnId: string): Promise<void> {
    await this.pg.query(
      'UPDATE alert_bot_turns SET placeholder_started_at = NULL WHERE id = $1 AND placeholder_message_id IS NULL',
      [turnId],
    );
  }

  async attachPlaceholder(turnId: string, messageId: number): Promise<void> {
    await this.pg.query(
      'UPDATE alert_bot_turns SET placeholder_message_id = $2 WHERE id = $1',
      [turnId, messageId],
    );
  }

  async markModelStarted(turnId: string): Promise<void> {
    await this.pg.query(
      'UPDATE alert_bot_turns SET model_started_at = COALESCE(model_started_at, now()) WHERE id = $1',
      [turnId],
    );
  }

  async markDeliveryStarted(turnId: string): Promise<void> {
    await this.pg.query(
      `UPDATE alert_bot_turns
       SET delivery_started_at = COALESCE(delivery_started_at, now())
       WHERE id = $1 AND delivery_completed_at IS NULL`,
      [turnId],
    );
  }

  async deferDelivery(turnId: string): Promise<void> {
    await this.pg.query(
      'UPDATE alert_bot_turns SET delivery_started_at = NULL WHERE id = $1 AND delivery_completed_at IS NULL',
      [turnId],
    );
  }

  async completeDelivery(turnId: string, messageIds: number[]): Promise<void> {
    const ids = Array.from(new Set(messageIds.filter((id) => Number.isSafeInteger(id) && id > 0)));
    if (!ids.length) throw new Error('answer message ids missing');
    await this.pg.query(
      `UPDATE alert_bot_turns
       SET answer_message_id = $2, answer_message_ids = $3::jsonb,
           delivery_started_at = NULL, delivery_completed_at = now()
       WHERE id = $1`,
      [turnId, ids[0], JSON.stringify(ids)],
    );
  }

  async attachAnswerMessages(turnId: string, messageIds: number[]): Promise<void> {
    const ids = Array.from(new Set(messageIds.filter((id) => Number.isSafeInteger(id) && id > 0)));
    if (!ids.length) throw new Error('answer message ids missing');
    await this.pg.query(
      `UPDATE alert_bot_turns
       SET answer_message_id = $2, answer_message_ids = $3::jsonb
       WHERE id = $1`,
      [turnId, ids[0], JSON.stringify(ids)],
    );
  }

  async finishTurn(turnId: string, result: FinishTurnResult): Promise<boolean> {
    const fields: Array<[string, unknown]> = [['status', result.status]];
    if (result.answer !== undefined) fields.push(['answer', result.answer]);
    if (result.tools !== undefined) fields.push(['tools', JSON.stringify(result.tools)]);
    if (result.errorKind !== undefined) fields.push(['error_kind', result.errorKind]);
    if (result.durationMs !== undefined) fields.push(['duration_ms', result.durationMs]);
    if (result.costUsd !== undefined) fields.push(['cost_usd', result.costUsd]);
    const params = fields.map(([, value]) => value);
    params.push(turnId);
    const assignments = fields.map(([column], index) => `${column} = $${index + 1}`);
    const r = await this.pg.query(
      `UPDATE alert_bot_turns
       SET ${assignments.join(', ')}, finished_at = now()
       WHERE id = $${params.length} AND status = 'in_progress'`,
      params,
    );
    return r.rowCount === 1;
  }

  async findTurnByUpdate(updateId: number): Promise<AlertBotTurn | null> {
    const r = await this.pg.query('SELECT * FROM alert_bot_turns WHERE update_id = $1 LIMIT 1', [updateId]);
    return r.rows[0] ? mapTurn(r.rows[0]) : null;
  }

  async findTurnByAnswer(chatId: string, answerMessageId: number): Promise<AlertBotTurn | null> {
    const r = await this.pg.query(
      `SELECT * FROM alert_bot_turns
       WHERE chat_id = $1
         AND (answer_message_id = $2 OR answer_message_ids @> $3::jsonb)
       LIMIT 1`,
      [chatId, answerMessageId, JSON.stringify([answerMessageId])],
    );
    return r.rows[0] ? mapTurn(r.rows[0]) : null;
  }

  async turnChain(turnId: string, limit = 3): Promise<AlertBotTurn[]> {
    const result: AlertBotTurn[] = [];
    const seen = new Set<string>();
    let currentId: string | null = turnId;
    const max = Math.max(0, Math.trunc(limit));
    while (currentId && result.length < max && !seen.has(currentId)) {
      seen.add(currentId);
      const r = await this.pg.query(
        "SELECT * FROM alert_bot_turns WHERE id = $1 AND status = 'ok'",
        [currentId],
      );
      if (!r.rows[0]) break;
      const turn = mapTurn(r.rows[0]);
      result.unshift(turn);
      currentId = turn.parentTurnId;
    }
    return result;
  }

  async recentTurns(chatId: string, limit = 3, withinMinutes = 30): Promise<AlertBotTurn[]> {
    const r = await this.pg.query(
      `SELECT * FROM alert_bot_turns
       WHERE chat_id = $1 AND status = 'ok'
         AND created_at >= now() - ($3 * interval '1 minute')
       ORDER BY created_at DESC LIMIT $2`,
      [chatId, limit, withinMinutes],
    );
    return r.rows.map(mapTurn).reverse();
  }

  async countRecentTurns(adminUserId: string): Promise<number> {
    const r = await this.pg.query(
      `SELECT count(*)::int AS n FROM alert_bot_turns
       WHERE linkeon_user_id = $1 AND created_at >= now() - interval '1 hour'
         AND status IN ('in_progress', 'ok', 'model_down', 'timeout', 'error', 'interrupted')`,
      [adminUserId],
    );
    return r.rows[0].n;
  }

  async interruptInProgress(): Promise<Array<{ id: string; chatId: string; questionMessageId: number }>> {
    const r = await this.pg.query(
      `UPDATE alert_bot_turns
       SET status = 'interrupted', error_kind = 'restart', finished_at = now()
       WHERE status = 'in_progress'
       RETURNING id, chat_id, question_message_id`,
    );
    return r.rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      questionMessageId: Number(row.question_message_id),
    }));
  }

  async recordAlert(chatId: string, messageId: number, text: string): Promise<void> {
    await this.pg.query(
      'INSERT INTO alert_messages (chat_id, message_id, text) VALUES ($1, $2, $3)',
      [chatId, messageId, text],
    );
  }

  async recentAlerts(hours: number, limit = 50, signal?: AbortSignal): Promise<AlertMessage[]> {
    const boundedHours = clampInteger(hours, 1, 72);
    const boundedLimit = clampInteger(limit, 1, 50);
    const r = await this.pg.query(
      `SELECT * FROM alert_messages
       WHERE created_at >= now() - ($1 * interval '1 hour')
       ORDER BY created_at DESC LIMIT $2`,
      [boundedHours, boundedLimit],
      signal,
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      chatId: row.chat_id,
      messageId: Number(row.message_id),
      text: row.text,
      createdAt: row.created_at,
    }));
  }

  async attachDraftPrompt(id: string, promptMessageId: number): Promise<void> {
    await this.pg.query(
      'UPDATE alert_bot_ticket_drafts SET prompt_message_id = $2 WHERE id = $1',
      [id, promptMessageId],
    );
  }

  async createDraft(input: CreateDraftInput): Promise<string> {
    const r = await this.pg.query(
      `INSERT INTO alert_bot_ticket_drafts
         (chat_id, tg_user_id, linkeon_user_id, ticket_id, text, prompt_message_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.chatId, input.tgUserId, input.adminUserId, input.ticketId, input.text, input.promptMessageId ?? null],
    );
    return r.rows[0].id;
  }

  async getDraft(id: string): Promise<AlertBotDraft | null> {
    const r = await this.pg.query('SELECT * FROM alert_bot_ticket_drafts WHERE id = $1', [id]);
    return r.rows[0] ? mapDraft(r.rows[0]) : null;
  }

  async consumeDraft(id: string, outcome: AlertBotDraftOutcome): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE alert_bot_ticket_drafts
       SET outcome = $2, resolved_at = now()
       WHERE id = $1 AND outcome IS NULL AND expires_at > now()
       RETURNING id`,
      [id, outcome],
    );
    return r.rowCount === 1;
  }

  async claimDraft(id: string, claim: AlertBotDraftClaim): Promise<AlertBotDraftClaimResult> {
    const r = await this.pg.query(
      `UPDATE alert_bot_ticket_drafts
       SET outcome = $2, claimed_at = now(), claim_version = claim_version + 1,
           resolved_at = NULL
       WHERE id = $1 AND expires_at > now()
         AND (
           outcome IS NULL
           OR (
             outcome IN ('sending', 'asking', 'cancelling')
             AND (claimed_at IS NULL OR claimed_at < now() - interval '60 seconds')
           )
         )
       RETURNING claim_version`,
      [id, claim],
    );
    if (r.rowCount === 1) return { status: 'claimed', version: Number(r.rows[0].claim_version) };

    const active = await this.pg.query(
      `SELECT id FROM alert_bot_ticket_drafts
       WHERE id = $1 AND expires_at > now()
         AND outcome IN ('sending', 'asking', 'cancelling')
         AND claimed_at >= now() - interval '60 seconds'
       LIMIT 1`,
      [id],
    );
    return { status: active.rows[0] ? 'in_progress' : 'unavailable' };
  }

  async finalizeDraft(
    id: string,
    expectedAction: AlertBotDraftClaim | null,
    outcome: AlertBotDraftOutcome,
    version: number,
  ): Promise<boolean> {
    const validTransition = outcome === 'cancelled'
      ? expectedAction === null || ['sending', 'asking', 'cancelling'].includes(expectedAction)
      : outcome === 'sent'
        ? expectedAction === 'sending' || expectedAction === 'asking' || expectedAction === 'cancelling'
        : outcome === 'asked' && expectedAction === 'asking';
    if (!validTransition || !Number.isSafeInteger(version) || version < 0) return false;

    const r = await this.pg.query(
      `UPDATE alert_bot_ticket_drafts
       SET outcome = $3, claimed_at = NULL, resolved_at = now()
       WHERE id = $1 AND outcome IS NOT DISTINCT FROM $2 AND claim_version = $4
       RETURNING id`,
      [id, expectedAction, outcome, version],
    );
    return r.rowCount === 1;
  }

  async releaseDraft(id: string, expectedAction: AlertBotDraftClaim, version: number): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE alert_bot_ticket_drafts
       SET outcome = NULL, claimed_at = NULL, resolved_at = NULL
       WHERE id = $1 AND outcome = $2 AND claim_version = $3
       RETURNING id`,
      [id, expectedAction, version],
    );
    return r.rowCount === 1;
  }

  async cleanup(): Promise<void> {
    await this.pg.query(
      `DELETE FROM alert_bot_updates
       WHERE created_at < now() - $1::interval
         AND (status = 'completed' OR (status = 'failed' AND next_retry_at IS NULL))`,
      ['7 days'],
    );
    await this.pg.query('DELETE FROM alert_messages WHERE created_at < now() - $1::interval', ['30 days']);
    await this.pg.query('DELETE FROM alert_bot_ticket_drafts WHERE created_at < now() - $1::interval', ['30 days']);
    await this.pg.query('DELETE FROM alert_bot_turns WHERE created_at < now() - $1::interval', ['90 days']);
  }
}
