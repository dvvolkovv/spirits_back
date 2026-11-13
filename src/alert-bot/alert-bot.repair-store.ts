import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { RepairFinalStatus, RepairOutcomeJob } from './alert-bot.repair-outcome';

export type RepairAdmission =
  | { status: 'accepted'; repairId: string }
  | { status: 'existing'; repairId: string }
  | { status: 'busy' };

export interface RepairIdentityGuard {
  repairId: string;
  turnId: string;
  chatId: string;
  adminTgId: string;
}

export interface AdmitRepairInput {
  updateId: number;
  chatId: string;
  adminTgId: string;
  instruction: string;
}

export interface CreateRepairJobInput {
  repairId: string;
  host: string;
  command: string;
  kind: 'exec' | 'verify';
  mutates: boolean;
  interruptible: boolean;
  timeoutMs: number;
}

export interface RepairRecord {
  id: string;
  updateId: number;
  turnId: string | null;
  chatId: string;
  adminTgId: string;
  instruction: string;
  status: 'requested' | 'running' | 'cancel_requested' | RepairFinalStatus;
  failureKind: string | null;
  mutationCount: number;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface RepairJobRecord extends RepairOutcomeJob {
  repairId: string;
  host: 'prod' | 'relay' | 'test';
  command: string;
  interruptible: boolean;
  timeoutMs: number;
  stdout: string;
  stderr: string;
  failureKind: string | null;
}

export interface FinishRepairJobResult {
  status: 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failureKind?: string | null;
}

function mapRepair(row: any): RepairRecord {
  return {
    id: row.id,
    updateId: Number(row.update_id),
    turnId: row.turn_id,
    chatId: row.chat_id,
    adminTgId: row.admin_tg_id,
    instruction: row.instruction,
    status: row.status,
    failureKind: row.failure_kind,
    mutationCount: Number(row.mutation_count),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function mapJob(row: any): RepairJobRecord {
  return {
    id: row.id,
    repairId: row.repair_id,
    sequence: Number(row.sequence),
    host: row.host,
    command: row.command_redacted,
    kind: row.kind,
    mutates: row.mutates,
    interruptible: row.interruptible,
    timeoutMs: Number(row.requested_timeout_ms),
    status: row.status,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    stdout: row.stdout_redacted ?? '',
    stderr: row.stderr_redacted ?? '',
    failureKind: row.failure_kind,
  };
}

@Injectable()
export class RepairStore {
  constructor(private readonly pg: PgService) {}

  async migrate(): Promise<void> {
    const candidates = [
      path.join(__dirname, 'migrations', '002_alert_bot_repair.sql'),
      path.join(__dirname, '..', '..', 'src', 'alert-bot', 'migrations', '002_alert_bot_repair.sql'),
    ];
    const migrationPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!migrationPath) throw new Error('alert-bot migration 002_alert_bot_repair.sql not found');
    await this.pg.query(fs.readFileSync(migrationPath, 'utf8'));
  }

  async admitRepair(input: AdmitRepairInput): Promise<RepairAdmission> {
    const client = await this.pg.getClient();
    let transactionOpen = false;
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alert-bot-repair:${input.chatId}`]);

      const existing = await client.query('SELECT id FROM alert_bot_repairs WHERE update_id = $1', [input.updateId]);
      if (existing.rows[0]) {
        await client.query('COMMIT');
        transactionOpen = false;
        return { status: 'existing', repairId: existing.rows[0].id };
      }

      const active = await client.query(
        `SELECT id FROM alert_bot_repairs
         WHERE chat_id = $1 AND status IN ('requested', 'running', 'cancel_requested')
         LIMIT 1`,
        [input.chatId],
      );
      if (active.rows[0]) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { status: 'busy' };
      }

      const inserted = await client.query(
        `INSERT INTO alert_bot_repairs (update_id, chat_id, admin_tg_id, instruction)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.updateId, input.chatId, input.adminTgId, input.instruction],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { status: 'accepted', repairId: inserted.rows[0].id };
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

  async findRepair(id: string, signal?: AbortSignal): Promise<RepairRecord | null> {
    const result = await this.pg.query('SELECT * FROM alert_bot_repairs WHERE id = $1', [id], signal);
    return result.rows[0] ? mapRepair(result.rows[0]) : null;
  }

  async findRepairByUpdate(updateId: number): Promise<RepairRecord | null> {
    const result = await this.pg.query('SELECT * FROM alert_bot_repairs WHERE update_id = $1 LIMIT 1', [updateId]);
    return result.rows[0] ? mapRepair(result.rows[0]) : null;
  }

  async findActiveRepair(chatId: string): Promise<RepairRecord | null> {
    const result = await this.pg.query(
      `SELECT * FROM alert_bot_repairs
       WHERE chat_id = $1 AND status IN ('requested', 'running', 'cancel_requested')
       LIMIT 1`,
      [chatId],
    );
    return result.rows[0] ? mapRepair(result.rows[0]) : null;
  }

  async isActiveRepair(guard: RepairIdentityGuard): Promise<boolean> {
    const result = await this.pg.query(
      `SELECT id FROM alert_bot_repairs
       WHERE id = $1 AND turn_id = $2 AND chat_id = $3 AND admin_tg_id = $4
         AND status IN ('requested', 'running')`,
      [guard.repairId, guard.turnId, guard.chatId, guard.adminTgId],
    );
    return result.rowCount === 1;
  }

  async markRepairRunning(id: string, turnId: string): Promise<boolean> {
    const result = await this.pg.query(
      `UPDATE alert_bot_repairs SET status = 'running', turn_id = $2
       WHERE id = $1 AND status = 'requested'`,
      [id, turnId],
    );
    return result.rowCount === 1;
  }

  async requestCancel(id: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.pg.query(
      `UPDATE alert_bot_repairs SET status = 'cancel_requested'
       WHERE id = $1 AND status IN ('requested', 'running')`,
      [id],
      signal,
    );
    return result.rowCount === 1;
  }

  async finishRepair(id: string, status: RepairFinalStatus, mutationCount: number): Promise<boolean> {
    const result = await this.pg.query(
      `UPDATE alert_bot_repairs
       SET status = $2, mutation_count = $3, finished_at = now()
       WHERE id = $1 AND (
         status IN ('requested', 'running')
         OR (status = 'cancel_requested' AND $2 IN ('cancelled', 'interrupted'))
       )`,
      [id, status, mutationCount],
    );
    return result.rowCount === 1;
  }

  async abandon(id: string): Promise<boolean> {
    const result = await this.pg.query(
      `UPDATE alert_bot_repairs SET status = 'cancelled', finished_at = now()
       WHERE id = $1 AND status = 'requested' AND turn_id IS NULL`,
      [id],
    );
    return result.rowCount === 1;
  }

  async createJob(input: CreateRepairJobInput): Promise<{ id: string; sequence: number } | null> {
    const lockKey = `alert-bot-repair-job:${input.repairId}`;
    const client = await this.pg.getClient();
    let transactionOpen = false;
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      const repair = await client.query(
        `SELECT r.id FROM alert_bot_repairs r
         WHERE r.id = $1 AND r.status IN ('requested', 'running')
           AND NOT EXISTS (
             SELECT 1 FROM alert_bot_repair_jobs j
             WHERE j.repair_id = r.id
               AND j.failure_kind IN ('process_close_unconfirmed', 'remote_outcome_unknown')
           )
         FOR UPDATE`,
        [input.repairId],
      );
      if (!repair.rows[0]) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }
      const activeJob = await client.query(
        `SELECT id FROM alert_bot_repair_jobs
         WHERE repair_id = $1 AND status IN ('queued', 'running')
         LIMIT 1`,
        [input.repairId],
      );
      if (activeJob.rows[0]) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }
      const next = await client.query(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM alert_bot_repair_jobs WHERE repair_id = $1',
        [input.repairId],
      );
      const inserted = await client.query(
        `INSERT INTO alert_bot_repair_jobs
           (repair_id, sequence, host, command_redacted, kind, mutates, interruptible, requested_timeout_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, sequence`,
        [
          input.repairId,
          next.rows[0].sequence,
          input.host,
          input.command,
          input.kind,
          input.mutates,
          input.interruptible,
          input.timeoutMs,
        ],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { id: inserted.rows[0].id, sequence: Number(inserted.rows[0].sequence) };
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroyClient = true;
        }
      }
      const pgError = error as { code?: string; constraint?: string };
      if (pgError.code === '23505' && pgError.constraint === 'idx_alert_bot_repair_jobs_active') return null;
      throw error;
    } finally {
      client.release(destroyClient);
    }
  }

  async hasUnknownOutcome(repairId: string): Promise<boolean> {
    const result = await this.pg.query(
      `SELECT 1 FROM alert_bot_repair_jobs
       WHERE repair_id = $1
         AND failure_kind IN ('process_close_unconfirmed', 'remote_outcome_unknown')
       LIMIT 1`,
      [repairId],
    );
    return result.rowCount === 1;
  }

  async listJobs(repairId: string): Promise<RepairJobRecord[]> {
    const result = await this.pg.query(
      'SELECT * FROM alert_bot_repair_jobs WHERE repair_id = $1 ORDER BY sequence',
      [repairId],
    );
    return result.rows.map(mapJob);
  }

  async findJob(id: string, signal?: AbortSignal): Promise<RepairJobRecord | null> {
    const result = await this.pg.query('SELECT * FROM alert_bot_repair_jobs WHERE id = $1', [id], signal);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async markJobRunning(id: string): Promise<boolean> {
    const result = await this.pg.query(
      `UPDATE alert_bot_repair_jobs j
       SET status = 'running', started_at = now()
       FROM alert_bot_repairs r
       WHERE j.id = $1 AND j.status = 'queued'
         AND r.id = j.repair_id AND r.status IN ('requested', 'running')
       RETURNING j.id`,
      [id],
    );
    return result.rowCount === 1;
  }

  async finishJob(id: string, result: FinishRepairJobResult, signal?: AbortSignal): Promise<boolean> {
    const updated = await this.pg.query(
      `UPDATE alert_bot_repair_jobs
       SET status = $2, exit_code = $3, stdout_redacted = $4, stderr_redacted = $5,
           failure_kind = $6, finished_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, result.status, result.exitCode, result.stdout, result.stderr, result.failureKind ?? null],
      signal,
    );
    return updated.rowCount === 1;
  }

  async finishUnknownAndCancelRepair(
    jobId: string,
    repairId: string,
    result: FinishRepairJobResult,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Один statement = одна неявная транзакция. Advisory lock и repair FOR UPDATE
    // выполняются в том же порядке, что и createJob, до любого UPDATE.
    const lockKey = `alert-bot-repair-job:${repairId}`;
    const updated = await this.pg.query(
      `WITH lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtext($1))
       ), repair_lock AS MATERIALIZED (
         SELECT r.id FROM alert_bot_repairs r
         WHERE r.id = $3 AND EXISTS (SELECT 1 FROM lock)
         FOR UPDATE
       ), finished AS (
         UPDATE alert_bot_repair_jobs
         SET status = $4, exit_code = $5, stdout_redacted = $6, stderr_redacted = $7,
             failure_kind = $8, finished_at = now()
         WHERE id = $2 AND repair_id = $3 AND status IN ('queued', 'running')
           AND EXISTS (SELECT 1 FROM repair_lock)
         RETURNING id
       ), cancelled AS (
         UPDATE alert_bot_repairs SET status = 'cancel_requested'
         WHERE id = $3 AND status IN ('requested', 'running')
           AND EXISTS (SELECT 1 FROM finished)
         RETURNING id
       )
       SELECT id FROM finished`,
      [lockKey, jobId, repairId, result.status, result.exitCode, result.stdout, result.stderr, result.failureKind ?? null],
      signal,
    );
    return updated.rowCount === 1;
  }

  async interruptActive(): Promise<RepairRecord[]> {
    const client = await this.pg.getClient();
    let transactionOpen = false;
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const repairs = await client.query(
        `UPDATE alert_bot_repairs SET status = 'interrupted', finished_at = now()
         WHERE status IN ('requested', 'running', 'cancel_requested')
         RETURNING *`,
      );
      await client.query(
        `UPDATE alert_bot_repair_jobs SET status = 'interrupted', finished_at = now()
         WHERE status IN ('queued', 'running')`,
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return repairs.rows.map(mapRepair);
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

  async cleanup(): Promise<void> {
    await this.pg.query(
      `DELETE FROM alert_bot_repairs
       WHERE created_at < now() - interval '90 days'
         AND status IN ('verified', 'unverified', 'failed', 'timeout', 'cancelled', 'interrupted')`,
    );
  }
}
