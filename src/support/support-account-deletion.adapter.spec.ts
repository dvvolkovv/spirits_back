jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  tool: (name: string, description: string, schema: any, handler: any) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: any) => o,
}));
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => false),
  sendTelegramPayload: jest.fn(async () => {}),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DELETION_DEPENDENCIES,
  DELETION_DISCOVERERS,
} from '../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  safeDeletionJobSnapshot,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { SupportModule } from './support.module';
import { SupportService } from './support.service';
import {
  discoverSupportDeletion,
  SupportAccountDeletionAdapter,
} from './support-account-deletion.adapter';

/**
 * Task 17A — support: немедленная остановка и delayed purge.
 *
 * support.stop закрывает незавершённые tickets удалённого поколения
 * ('ai_handling','escalated','owner_handling' → 'closed' — статусы CHECK
 * схемы 001_support.sql; 'resolved' остаётся как уже терминальный).
 * support.purge: сначала alert_bot_ticket_drafts ЯВНО по ticket IDs
 * (у drafts.ticket_id нет FK на support_tickets — 001_alert_bot.sql:22-24),
 * затем support_tickets WHERE id+user_id; support_messages/support_events
 * исчезают существующим FK ON DELETE CASCADE (001_support.sql:33,48).
 *
 * service_health (общий снапшот здоровья сервисов) и alert_bot_turns
 * (операционный журнал alert-бота, владелец строк — оператор поддержки)
 * в SQL удаления НЕ упоминаются и сохраняются — RED-тест пинит длину 1.
 *
 * Отдельный RED (в плане предложен support.controller.spec.ts, но тот спек
 * мокает сервис целиком — гейты проверяются здесь на реальном SupportService
 * с фейковой БД): getOrCreateActiveTicket/getLatestOrCreateTicket/
 * postUserMessage/adminReply для deleted-владельца не создают ticket/message.
 * adminReply проверяет состояние ВЛАДЕЛЬЦА тикета (user_id), не админа.
 * claim_version-логика draft'ов не затрагивается: гейт стоит до входа в
 * транзакцию postOwnerReply.
 */

const USER = 'u-deleted';
const OTHER = 'u-other';
const ADMIN = 'u-admin';
const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OTHER_GENERATION = '11111111-2222-4333-8444-555555555555';
const TICKET_OWN = 'aaaaaaaa-0000-4000-8000-000000000001';
const TICKET_OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const MESSAGE_CANARY = 'КАНАРЕЙКА-ЛИЧНАЯ-ПЕРЕПИСКА';
const DRAFT_CANARY = 'КАНАРЕЙКА-ЧЕРНОВИК-ОТВЕТА';

interface TicketRow {
  id: string;
  user_id: string;
  status: 'ai_handling' | 'escalated' | 'owner_handling' | 'resolved' | 'closed';
  created_at: Date;
}

interface MessageRow {
  id: string;
  ticket_id: string;
  sender_type: string;
  sender_id: string | null;
  content: string;
  visible_to_user: boolean;
}

interface EventRow {
  id: string;
  ticket_id: string;
  actor_type: string;
  action: string;
}

interface DraftRow {
  id: string;
  ticket_id: string;
  linkeon_user_id: string;
  text: string;
  outcome: string | null;
}

const OPEN_STATUSES = ['ai_handling', 'escalated', 'owner_handling'];

function dbError(): Error {
  // SQLSTATE 08006 (connection_failure) → deletionErrorKind = 'db'.
  return Object.assign(new Error('connection terminated'), { code: '08006' });
}

/**
 * Фейковая БД: SQL-семантика адаптера и SupportService (generation/active
 * гейты, scoped UPDATE/DELETE, FK CASCADE support_tickets → messages/events,
 * транзакционный client для postOwnerReply). Неизвестный запрос — throw:
 * service_health/alert_bot_turns не маршрутизированы, поэтому любой SQL,
 * который их коснётся, уронит тест.
 */
class FakeSupportDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  tickets: TicketRow[] = [];
  supportMessages: MessageRow[] = [];
  supportEvents: EventRow[] = [];
  drafts: DraftRow[] = [];
  /** Общие операционные таблицы — purge их не трогает (пин toHaveLength(1)). */
  serviceHealth: Array<{ service: string; status: string }> = [];
  alertBotTurns: Array<{ id: string; linkeon_user_id: string }> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  readonly calls: string[] = [];
  failWrites = false;
  getClientCalls = 0;
  private nextNum = 1;

  async getClient() {
    this.getClientCalls += 1;
    return {
      query: (sql: string, params?: any[]) => this.query(sql, params ?? []),
      release: () => undefined,
    };
  }

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT 1 FROM user_id')) {
      if (s.includes(`state = 'active'`)) {
        const [userId] = params as [string];
        const ok = this.users.get(String(userId))?.state === 'active';
        return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      const [userId, genId] = params as [string, string];
      const ok = this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT count(*)::int AS n FROM support_messages')) {
      return { rows: [{ n: 0 }], rowCount: 1 };
    }
    if (s.startsWith('SELECT id FROM support_tickets')) {
      // support.purge step 1: ids тикетов поколения.
      const [userId, genId] = params as [string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const rows = this.tickets
        .filter((t) => t.user_id === String(userId))
        .map((t) => ({ id: t.id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT user_id FROM support_tickets WHERE id = $1')) {
      const [ticketId] = params as [string];
      const rows = this.tickets
        .filter((t) => t.id === String(ticketId))
        .map((t) => ({ user_id: t.user_id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT status FROM support_tickets WHERE id = $1 FOR UPDATE')) {
      const [ticketId] = params as [string];
      const rows = this.tickets
        .filter((t) => t.id === String(ticketId))
        .map((t) => ({ status: t.status }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT t.* FROM support_tickets')) {
      const [userId] = params as [string];
      const rows = this.tickets.filter((t) => t.user_id === String(userId)
        && this.supportMessages.some((m) => m.ticket_id === t.id && m.visible_to_user));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT * FROM support_tickets WHERE user_id = $1')) {
      const [userId] = params as [string];
      let rows = this.tickets.filter((t) => t.user_id === String(userId));
      if (s.includes('status IN')) {
        rows = rows.filter((t) => OPEN_STATUSES.includes(t.status));
      }
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT p.email')) {
      // notifyOwnerReplyByEmail: профиля нет → 'no_profile', без письма.
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('INSERT INTO support_tickets')) {
      if (this.failWrites) throw dbError();
      const [userId] = params as [string];
      const row: TicketRow = {
        id: `ticket-${this.nextNum++}`,
        user_id: String(userId),
        status: 'ai_handling',
        created_at: new Date('2026-11-14T00:00:00Z'),
      };
      this.tickets.push(row);
      this.calls.push('db.insertTicket');
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO support_messages')) {
      if (this.failWrites) throw dbError();
      const [ticketId, senderType, senderId, content] = params as any[];
      const visible = params.length >= 6 ? Boolean(params[5]) : true;
      const row: MessageRow = {
        id: `msg-${this.nextNum++}`,
        ticket_id: String(ticketId),
        sender_type: String(senderType),
        sender_id: senderId == null ? null : String(senderId),
        content: String(content),
        visible_to_user: visible,
      };
      this.supportMessages.push(row);
      this.calls.push('db.insertMessage');
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO support_events')) {
      if (this.failWrites) throw dbError();
      const [ticketId, actorType, actorId, action] = params as any[];
      this.supportEvents.push({
        id: `ev-${this.nextNum++}`,
        ticket_id: String(ticketId),
        actor_type: String(actorType),
        action: String(action ?? (/'reply'/.test(s) ? 'reply' : 'status_change')),
      });
      void actorId;
      this.calls.push('db.insertEvent');
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE support_tickets')) {
      if (this.failWrites) throw dbError();
      if (s.includes(`SET status='closed'`)) {
        // support.stop: незавершённые тикеты поколения → closed.
        const [userId, genId] = params as [string, string];
        if (!this.isCurrentDeletion(String(userId), String(genId))) {
          return { rows: [], rowCount: 0 };
        }
        let n = 0;
        for (const t of this.tickets) {
          if (t.user_id === String(userId) && OPEN_STATUSES.includes(t.status)) {
            t.status = 'closed';
            n += 1;
          }
        }
        this.calls.push('db.stopTickets');
        return { rows: [], rowCount: n };
      }
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE backlog_items')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM alert_bot_ticket_drafts')) {
      if (this.failWrites) throw dbError();
      // support.purge step 2: drafts по ticket IDs, под generation predicate.
      const [ids, userId, genId] = params as [string[], string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const idSet = new Set((ids ?? []).map(String));
      const before = this.drafts.length;
      this.drafts = this.drafts.filter((d) => !idSet.has(d.ticket_id));
      this.calls.push('db.deleteDrafts');
      return { rows: [], rowCount: before - this.drafts.length };
    }
    if (s.startsWith('DELETE FROM support_tickets')) {
      if (this.failWrites) throw dbError();
      // support.purge step 3: id = ANY + user_id, под generation predicate.
      const [ids, userId, genId] = params as [string[], string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const idSet = new Set((ids ?? []).map(String));
      const removed = this.tickets.filter((t) => idSet.has(t.id) && t.user_id === String(userId));
      const removedIds = new Set(removed.map((t) => t.id));
      this.tickets = this.tickets.filter((t) => !removedIds.has(t.id));
      // FK ON DELETE CASCADE: support_messages.ticket_id, support_events.ticket_id.
      this.supportMessages = this.supportMessages.filter((m) => !removedIds.has(m.ticket_id));
      this.supportEvents = this.supportEvents.filter((e) => !removedIds.has(e.ticket_id));
      this.calls.push('db.deleteTickets');
      return { rows: [], rowCount: removed.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }
}

function makeHarness() {
  const db = new FakeSupportDb();
  db.users.set(USER, { state: 'deleted', deletionId });
  db.users.set(OTHER, { state: 'active', deletionId: null });
  db.users.set(ADMIN, { state: 'active', deletionId: null });
  db.serviceHealth.push({ service: 'openai', status: 'healthy' });
  db.alertBotTurns.push({ id: 'turn-1', linkeon_user_id: ADMIN });
  const registry = new AccountDeletionRegistry();
  const adapter = new SupportAccountDeletionAdapter(registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, registry, adapter, ctx };
}

function supportJob(
  resourceType: 'support.stop' | 'support.purge',
  overrides: Partial<DeletionJobRow> = {},
): DeletionJobRow {
  return {
    id: `job-${resourceType}`,
    deletionId,
    userId: USER,
    resourceType,
    resourceKey: 'support',
    phase: resourceType === 'support.stop' ? 'immediate' : 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-14T00:00:00Z'),
    leaseUntil: new Date('2026-11-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

function seedOwnTicket(db: FakeSupportDb, status: TicketRow['status'] = 'ai_handling') {
  db.tickets.push({ id: TICKET_OWN, user_id: USER, status, created_at: new Date('2026-11-10T00:00:00Z') });
  db.supportMessages.push({
    id: 'm-1', ticket_id: TICKET_OWN, sender_type: 'user', sender_id: USER,
    content: MESSAGE_CANARY, visible_to_user: true,
  });
  db.supportEvents.push({
    id: 'e-1', ticket_id: TICKET_OWN, actor_type: 'ai', action: 'escalate',
  });
  db.drafts.push({
    id: 'd-1', ticket_id: TICKET_OWN, linkeon_user_id: ADMIN,
    text: DRAFT_CANARY, outcome: null,
  });
}

function seedOtherTicket(db: FakeSupportDb) {
  db.tickets.push({ id: TICKET_OTHER, user_id: OTHER, status: 'ai_handling', created_at: new Date('2026-11-11T00:00:00Z') });
  db.supportMessages.push({
    id: 'm-2', ticket_id: TICKET_OTHER, sender_type: 'user', sender_id: OTHER,
    content: 'чужая переписка', visible_to_user: true,
  });
  db.supportEvents.push({ id: 'e-2', ticket_id: TICKET_OTHER, actor_type: 'ai', action: 'reply' });
  db.drafts.push({
    id: 'd-2', ticket_id: TICKET_OTHER, linkeon_user_id: ADMIN, text: 'чужой черновик', outcome: null,
  });
}

describe('discoverSupportDeletion — stop immediate + purge (Task 17A)', () => {
  it('два job: support.stop immediate и support.purge; payload {}, ключ без userId', async () => {
    const { db } = makeHarness();

    const plan = await discoverSupportDeletion({
      db,
      account: { userId: USER, deletionId, deletedAt: new Date('2026-11-14T00:00:00Z') },
      origin: 'explicit',
    });

    expect(plan.skips).toEqual([]);
    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[0]).toMatchObject({
      resourceType: 'support.stop', resourceKey: 'support', phase: 'immediate', payload: {},
    });
    expect(plan.jobs[1]).toMatchObject({
      resourceType: 'support.purge', resourceKey: 'support', phase: 'purge', payload: {},
    });
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(MESSAGE_CANARY);
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    // Discovery НЕ читает support_tickets/drafts — только generation gate.
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverSupportDeletion({
      db,
      account: { userId: USER, deletionId, deletedAt: new Date('2026-11-14T00:00:00Z') },
      origin: 'explicit',
    });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('SupportAccountDeletionAdapter.execute — stop → purge (Task 17A)', () => {
  it('support: сначала drafts, потом ticket; service_health и alert_bot_turns сохраняются', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedOwnTicket(db);

    await adapter.execute(supportJob('support.stop'), ctx);
    expect(db.tickets[0].status).toBe('closed');

    await adapter.execute(supportJob('support.purge'), ctx);
    expect(db.drafts).toHaveLength(0);
    expect(db.tickets).toHaveLength(0);
    expect(db.supportMessages).toHaveLength(0);
    expect(db.supportEvents).toHaveLength(0);
    expect(db.serviceHealth).toHaveLength(1);
    expect(db.alertBotTurns).toHaveLength(1);
    // Порядок: drafts ЯВНО до tickets (FK на ticket_id нет — после удаления
    // тикетов их уже не выбрать).
    expect(db.calls.indexOf('db.deleteDrafts')).toBeLessThan(db.calls.indexOf('db.deleteTickets'));
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'support.purge' }),
    );
  });

  it('stop закрывает только незавершённые своего владельца; resolved и чужие не тронуты', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedOwnTicket(db, 'escalated');
    db.tickets.push(
      { id: 'aaaaaaaa-0000-4000-8000-000000000003', user_id: USER, status: 'resolved', created_at: new Date() },
      { id: 'aaaaaaaa-0000-4000-8000-000000000004', user_id: USER, status: 'closed', created_at: new Date() },
    );
    seedOtherTicket(db);

    await adapter.execute(supportJob('support.stop'), ctx);

    expect(db.tickets.map((t) => [t.id, t.status])).toEqual([
      [TICKET_OWN, 'closed'],
      ['aaaaaaaa-0000-4000-8000-000000000003', 'resolved'],
      ['aaaaaaaa-0000-4000-8000-000000000004', 'closed'],
      [TICKET_OTHER, 'ai_handling'],
    ]);
  });

  it('stop failure — DeletionRetryError(kind db), ticket остаётся для retry', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedOwnTicket(db);
    db.failWrites = true;

    await expect(adapter.execute(supportJob('support.stop'), ctx))
      .rejects.toMatchObject({ kind: 'db' });
    expect(db.tickets[0].status).toBe('ai_handling');
  });

  it('purge: чужие tickets/drafts/messages сохраняются; canary не уходит в запросы', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedOwnTicket(db);
    seedOtherTicket(db);

    await adapter.execute(supportJob('support.purge'), ctx);

    expect(db.tickets).toHaveLength(1);
    expect(db.tickets[0].id).toBe(TICKET_OTHER);
    expect(db.drafts).toHaveLength(1);
    expect(db.drafts[0].id).toBe('d-2');
    expect(db.supportMessages).toHaveLength(1);
    expect(db.supportEvents).toHaveLength(1);
    expect(db.serviceHealth).toHaveLength(1);
    expect(db.alertBotTurns).toHaveLength(1);
    const leaked = JSON.stringify(db.queries);
    expect(leaked).not.toContain(MESSAGE_CANARY);
    expect(leaked).not.toContain(DRAFT_CANARY);
  });

  it('generation mismatch — stop и purge матчат 0 строк, тихий успех', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: OTHER_GENERATION });
    seedOwnTicket(db);

    await expect(adapter.execute(supportJob('support.stop'), ctx)).resolves.toBeUndefined();
    await expect(adapter.execute(supportJob('support.purge'), ctx)).resolves.toBeUndefined();
    expect(db.tickets[0].status).toBe('ai_handling');
    expect(db.drafts).toHaveLength(1);
    expect(db.calls).not.toContain('db.stopTickets');
    expect(db.calls).not.toContain('db.deleteTickets');
  });

  it('reactivation до execute — DeletionCancelledError, записей нет', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedOwnTicket(db);
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(supportJob('support.purge'), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.calls).not.toContain('db.deleteDrafts');
    expect(db.tickets).toHaveLength(1);
  });

  it('идемпотентность: повторный purge — тихий успех', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedOwnTicket(db);

    await adapter.execute(supportJob('support.purge'), ctx);
    await expect(adapter.execute(supportJob('support.purge'), ctx)).resolves.toBeUndefined();
    expect(db.tickets).toHaveLength(0);
  });

  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();
    const job = { ...supportJob('support.purge'), resourceType: 'tasks.purge' as const };

    await expect(adapter.execute(job, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });
});

describe('SupportService — записи для deleted-владельца запрещены (Task 17A)', () => {
  function makeService() {
    const db = new FakeSupportDb();
    db.users.set(USER, { state: 'deleted', deletionId });
    db.users.set(OTHER, { state: 'active', deletionId: null });
    db.users.set(ADMIN, { state: 'active', deletionId: null });
    const service = new SupportService(db as any);
    return { db, service };
  }

  it('getOrCreateActiveTicket для deleted — отказ, ticket не создан', async () => {
    const { db, service } = makeService();

    await expect(service.getOrCreateActiveTicket(USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.tickets).toHaveLength(0);
    expect(db.calls).not.toContain('db.insertTicket');
  });

  it('getLatestOrCreateTicket для deleted — отказ, ticket не создан', async () => {
    const { db, service } = makeService();

    await expect(service.getLatestOrCreateTicket(USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.tickets).toHaveLength(0);
    expect(db.calls).not.toContain('db.insertTicket');
  });

  it('postUserMessage для deleted — отказ, ticket/message не созданы, canary не в запросах', async () => {
    const { db, service } = makeService();

    await expect(service.postUserMessage(USER, { content: MESSAGE_CANARY } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(db.tickets).toHaveLength(0);
    expect(db.supportMessages).toHaveLength(0);
    expect(db.calls).not.toContain('db.insertTicket');
    expect(db.calls).not.toContain('db.insertMessage');
    expect(JSON.stringify(db.queries)).not.toContain(MESSAGE_CANARY);
  });

  it('adminReply на ticket deleted-владельца — отказ, message не записан, транзакция не начата', async () => {
    const { db, service } = makeService();
    db.tickets.push({ id: TICKET_OWN, user_id: USER, status: 'ai_handling', created_at: new Date() });

    await expect(service.adminReply(TICKET_OWN, ADMIN, 'ответ оператора'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(db.supportMessages).toHaveLength(0);
    expect(db.supportEvents).toHaveLength(0);
    expect(db.getClientCalls).toBe(0);
  });

  it('adminReply на несуществующий ticket — NotFoundException', async () => {
    const { service } = makeService();

    await expect(service.adminReply('no-such-ticket', ADMIN, 'ответ'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('active: postUserMessage создаёт ticket и message как раньше (регрессия)', async () => {
    const { db, service } = makeService();
    jest.spyOn(service as any, 'generateAiResponse').mockResolvedValue(undefined);

    await expect(service.postUserMessage(OTHER, { content: 'вопрос про запуск бота' } as any))
      .resolves.toMatchObject({ ticketId: expect.any(String) });
    expect(db.tickets).toHaveLength(1);
    expect(db.tickets[0]).toMatchObject({ user_id: OTHER, status: 'ai_handling' });
    expect(db.supportMessages).toHaveLength(1);
    expect(db.supportMessages[0]).toMatchObject({ sender_type: 'user', content: 'вопрос про запуск бота' });
  });

  it('active: adminReply проходит гейт и пишет ответ владельца (регрессия)', async () => {
    const { db, service } = makeService();
    db.tickets.push({ id: TICKET_OTHER, user_id: OTHER, status: 'ai_handling', created_at: new Date() });

    await expect(service.adminReply(TICKET_OTHER, ADMIN, 'ответ оператора')).resolves.toBeUndefined();
    // Дождаться fire-and-forget notifyOwnerReplyByEmail (void).
    await new Promise((resolve) => setImmediate(resolve));

    expect(db.getClientCalls).toBe(1);
    expect(db.supportMessages).toHaveLength(1);
    expect(db.supportMessages[0]).toMatchObject({
      ticket_id: TICKET_OTHER, sender_type: 'owner', sender_id: ADMIN, content: 'ответ оператора',
    });
    expect(db.supportEvents.some((e) => e.action === 'reply')).toBe(true);
  });
});

describe('wiring support.stop/support.purge (Task 17A)', () => {
  it('adapter регистрирует оба типа, SupportModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new SupportAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['support.stop', 'support.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SupportModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SupportModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === SupportAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverSupportDeletion ровно один раз; purge ждёт stop', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverSupportDeletion),
    ).toHaveLength(1);
    // Порядок support.stop → support.purge обеспечивает DEPENDENCY_ELIGIBILITY_SQL
    // в claimNext (account-deletion.jobs.ts): при статическом resourceKey 'support'
    // правило allOf эквивалентно sameResourceKey (по одному job на аккаунт).
    expect(DELETION_DEPENDENCIES['support.purge']).toEqual({ allOf: ['support.stop'] });
  });
});
