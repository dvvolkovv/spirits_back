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
  parentTurnId: string | null;
  question: string;
  answer: string | null;
  tools: string[];
  status: AlertBotTurnStatus;
  errorKind: string | null;
  durationMs: number | null;
  costUsd: number | null;
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
    parentTurnId: row.parent_turn_id,
    question: row.question,
    answer: row.answer,
    tools: row.tools ?? [],
    status: row.status,
    errorKind: row.error_kind,
    durationMs: row.duration_ms,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
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

  async claimUpdate(updateId: number): Promise<boolean> {
    const r = await this.pg.query(
      `INSERT INTO alert_bot_updates (update_id) VALUES ($1)
       ON CONFLICT (update_id) DO NOTHING RETURNING update_id`,
      [updateId],
    );
    return r.rowCount === 1;
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

  async tryCreateTurn(input: TurnInput, maxPerHour: number): Promise<string | null> {
    const client = await this.pg.getClient();
    let transactionOpen = false;
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alert-bot:${input.adminUserId}`]);
      const count = await client.query(
        `SELECT count(*)::int AS n FROM alert_bot_turns
         WHERE linkeon_user_id = $1 AND created_at >= now() - interval '1 hour'
           AND status IN ('in_progress', 'ok', 'model_down', 'timeout', 'error', 'interrupted')`,
        [input.adminUserId],
      );
      if (count.rows[0].n >= maxPerHour) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
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
      return r.rows[0].id;
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

  async findTurnByAnswer(chatId: string, answerMessageId: number): Promise<AlertBotTurn | null> {
    const r = await this.pg.query(
      'SELECT * FROM alert_bot_turns WHERE chat_id = $1 AND answer_message_id = $2 LIMIT 1',
      [chatId, answerMessageId],
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

  async recentAlerts(hours: number, limit = 50): Promise<AlertMessage[]> {
    const boundedHours = clampInteger(hours, 1, 72);
    const boundedLimit = clampInteger(limit, 1, 50);
    const r = await this.pg.query(
      `SELECT * FROM alert_messages
       WHERE created_at >= now() - ($1 * interval '1 hour')
       ORDER BY created_at DESC LIMIT $2`,
      [boundedHours, boundedLimit],
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
      : (outcome === 'sent' && expectedAction === 'sending')
        || (outcome === 'asked' && expectedAction === 'asking');
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
    await this.pg.query('DELETE FROM alert_bot_updates WHERE created_at < now() - $1::interval', ['7 days']);
    await this.pg.query('DELETE FROM alert_messages WHERE created_at < now() - $1::interval', ['30 days']);
    await this.pg.query('DELETE FROM alert_bot_ticket_drafts WHERE created_at < now() - $1::interval', ['30 days']);
    await this.pg.query('DELETE FROM alert_bot_turns WHERE created_at < now() - $1::interval', ['90 days']);
  }
}
