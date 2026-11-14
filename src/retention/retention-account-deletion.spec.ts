import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  safeDeletionJobSnapshot,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { RetentionModule } from './retention.module';
import { RetentionRecipientResolver } from './retention-recipient-resolver';
import { RetentionService } from './retention.service';
import { CURIOUS_SEGMENT_SQL, GENERAL_SEGMENT_SQL } from './retention-sql';
import type { RetentionDraft, RetentionPreview } from './retention.types';
import {
  discoverRetentionDeletion,
  RetentionAccountDeletionAdapter,
} from './retention-account-deletion.adapter';

/**
 * Task 17C — retention/outreach: рассылки удалённым аккаунтам останавливаются
 * на уровне SQL (сегменты и resolver видят только state='active') плюс
 * повторная strict-проверка непосредственно перед транспортом.
 *
 * retention.stop — единственный job (union закрыт, 'retention.purge' нет):
 * у retention нет per-user персистентного состояния, которое нужно обратить —
 * сегменты без пользователя и так его не выбирают. execute — маркер фазы без
 * записей. suppression list (retention_email_unsubscribes, stateless-токены)
 * и security rate-limit TTL СОХРАНЯЮТСЯ: отписка переживает удаление аккаунта
 * (письма на освобождённый адрес продолжать ходить не должны).
 */

const USER = 'u-del-retention';
const OTHER = 'u-other-retention';
const CANARY = 'СЕКРЕТ-НЕ-ЛОГИРОВАТЬ';
const deletionId = '7d1e6a2c-3b4f-4c5d-9e6a-0f1a2b3c4d5e';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const account: DeletionAccount = { userId: USER, deletionId, deletedAt: DELETED_AT };

class FakeGenDb {
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  constructor(private genOk: boolean) {}
  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });
    if (s.startsWith('SELECT 1 FROM user_id')) {
      return this.genOk ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${s}`);
  }
}

function jobRow(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-retention.stop',
    deletionId,
    userId: USER,
    resourceType: 'retention.stop',
    resourceKey: 'retention',
    phase: 'immediate',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-14T00:00:00Z'),
    leaseUntil: new Date('2026-12-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

// ==================== Discovery / wiring ====================

describe('discoverRetentionDeletion — один stop-job, пустой payload (Task 17C)', () => {
  it('job retention.stop immediate; sanitizer плана проходит', async () => {
    const db = new FakeGenDb(true);

    const plan = await discoverRetentionDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      { resourceType: 'retention.stop', resourceKey: 'retention', phase: 'immediate', payload: {} },
    ]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(CANARY);
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    // Discovery — только generation gate, retention-таблицы не читаются.
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const db = new FakeGenDb(false);

    const plan = await discoverRetentionDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('wiring retention.stop (Task 17C)', () => {
  it('adapter регистрирует retention.stop, RetentionModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new RetentionAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['retention.stop']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, RetentionModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RetentionModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === RetentionAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverRetentionDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverRetentionDeletion),
    ).toHaveLength(1);
  });

  it('чужой resourceType — отказ до любой записи', async () => {
    const db = new FakeGenDb(true);
    const adapter = new RetentionAccountDeletionAdapter(new AccountDeletionRegistry());
    const ctx: DeletionExecution = { db, assertCurrent: jest.fn(async () => undefined) };

    await expect(
      adapter.execute(jobRow({ resourceType: 'avatar.purge' }), ctx),
    ).rejects.toThrow('unsupported_deletion_resource');
    expect(ctx.assertCurrent).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });
});

describe('retention.stop execute — маркер без записей (Task 17C)', () => {
  it('assertCurrent вызван, ни одного запроса: suppression list и TTL сохраняются', async () => {
    const db = new FakeGenDb(true);
    const adapter = new RetentionAccountDeletionAdapter(new AccountDeletionRegistry());
    const ctx: DeletionExecution = { db, assertCurrent: jest.fn(async () => undefined) };

    await expect(adapter.execute(jobRow(), ctx)).resolves.toBeUndefined();

    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'retention.stop' }),
    );
    expect(db.queries).toHaveLength(0);
  });

  it('reactivation между discovery и execute — DeletionCancelledError passthrough', async () => {
    const db = new FakeGenDb(true);
    const adapter = new RetentionAccountDeletionAdapter(new AccountDeletionRegistry());
    const ctx: DeletionExecution = {
      db,
      assertCurrent: jest.fn(async () => { throw new DeletionCancelledError(); }),
    };

    await expect(adapter.execute(jobRow(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.queries).toHaveLength(0);
  });

  it('повторный execute идемпотентен (нет состояния — нечему расходиться)', async () => {
    const db = new FakeGenDb(true);
    const adapter = new RetentionAccountDeletionAdapter(new AccountDeletionRegistry());
    const ctx: DeletionExecution = { db, assertCurrent: jest.fn(async () => undefined) };

    await adapter.execute(jobRow(), ctx);
    await expect(adapter.execute(jobRow(), ctx)).resolves.toBeUndefined();
    expect(db.queries).toHaveLength(0);
  });
});

// ==================== SQL-гейты сегментов и resolver ====================

describe('сегменты и resolver исключают не-активные аккаунты (Task 17C)', () => {
  it('GENERAL/CURIOUS сегменты джойнят user_id со state=active', () => {
    for (const sql of [GENERAL_SEGMENT_SQL, CURIOUS_SEGMENT_SQL]) {
      expect(sql).toContain('JOIN user_id u');
      expect(sql).toContain("u.state='active'");
    }
  });

  it('resolver: accounts-запрос фильтрует state, profiles/identities — через EXISTS', async () => {
    const captured: string[] = [];
    const fakePg = {
      query: jest.fn(async (sql: string) => {
        captured.push(sql.replace(/\s+/g, ' '));
        return { rows: [] };
      }),
    };
    const resolver = new RetentionRecipientResolver(
      fakePg as any,
      { resolveUserLanguage: async () => 'ru' } as any,
    );

    await resolver.resolve(['u-some']);

    const accounts = captured.find((s) => s.includes('internal_id::text'));
    expect(accounts).toBeDefined();
    expect(accounts).toContain("state='active'");
    const profiles = captured.find((s) => s.includes('FROM ai_profiles_consolidated'));
    expect(profiles).toBeDefined();
    expect(profiles).toContain('EXISTS');
    expect(profiles).toContain("u.state='active'");
    const identities = captured.find((s) => s.includes('FROM user_identities'));
    expect(identities).toBeDefined();
    expect(identities).toContain('EXISTS');
    expect(identities).toContain("u.state='active'");
  });
});

// ==================== Send path: повторная проверка перед транспортом ====================

const draft = (patch: Partial<RetentionDraft> = {}): RetentionDraft => ({
  user_id: 'u1', phone: '10000000001', email: 'u@example.test', channel: 'email',
  language: 'ru', subject: 'Subject', message: 'Body', last_at: new Date(),
  last_sent_at: null, in_cooldown: false, ...patch,
});

function previewOf(drafts: RetentionDraft[]): RetentionPreview {
  return {
    channel: 'mixed', campaign: 'retention_reengage_v1', window: { min_days: 3, max_days: 30 },
    cooldown_days: 14, count: drafts.length,
    summary: {
      email: drafts.filter((d) => d.channel === 'email').length,
      sms: drafts.filter((d) => d.channel === 'sms').length,
      no_channel: drafts.filter((d) => d.channel === 'no_channel').length,
      skipped_unsubscribed: 0,
    },
    drafts,
  };
}

function sendHarness(opts: { active: string[]; drafts: RetentionDraft[]; checkFails?: boolean }) {
  const svc = Object.create(RetentionService.prototype) as any;
  const active = new Set(opts.active);
  const tags: string[] = [];
  const queries: Array<{ sql: string; params: any[] }> = [];
  const segment = {
    preview: previewOf(opts.drafts),
    suppressed: new Map(),
    personalization: new Map(),
  };
  svc.buildGeneralSegment = jest.fn().mockResolvedValue(segment);
  svc.buildCuriousSegment = jest.fn().mockResolvedValue({
    ...segment,
    preview: { ...segment.preview, campaign: 'curious_return_v1' },
  });
  svc.pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: s, params });
      if (s.includes('FROM user_id') && /state\s*=\s*'active'/.test(s)) {
        tags.push('check');
        if (opts.checkFails) throw new Error('db down');
        return active.has(String(params[0]))
          ? { rows: [{ n: 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (s.includes('INSERT INTO events')) {
        tags.push('event');
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  svc.mail = {
    send: jest.fn(async () => {
      tags.push('mail');
      return { ok: true };
    }),
  };
  svc.unsubscribes = {
    ensureToken: jest.fn().mockResolvedValue('t'.repeat(43)),
    isUnsubscribed: jest.fn().mockResolvedValue(false),
  };
  svc.sendOutreachSms = jest.fn(async () => {
    tags.push('sms');
    return { ok: true };
  });
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { svc, tags, queries };
}

describe('send(): повторная strict-проверка непосредственно перед отправкой (Task 17C)', () => {
  it('удалённый email-получатель отсекается: ни письма, ни события', async () => {
    const { svc, tags, queries } = sendHarness({
      active: ['u-live'],
      drafts: [
        draft({ user_id: 'u-live', email: 'live@example.test', channel: 'email' }),
        draft({ user_id: 'u-gone', email: 'gone@example.test', channel: 'email' }),
      ],
    });

    const out = await svc.sendRetentionOutreach({ confirm: true });

    expect(out).toMatchObject({ sent: 1, failed: 0 });
    expect(out.results.map((r: any) => r.user_id)).toEqual(['u-live']);
    expect(svc.mail.send).toHaveBeenCalledTimes(1);
    expect(svc.mail.send.mock.calls[0][0]).toBe('live@example.test');
    // Проверка — после подготовки контента и до транспорта; для удалённого
    // события не пишется (skipped не персистится).
    expect(tags).toEqual(['check', 'mail', 'event', 'check']);
    const eventInserts = queries.filter((q) => q.sql.includes('INSERT INTO events'));
    expect(eventInserts).toHaveLength(1);
    expect(eventInserts[0].params[0]).toBe('u-live');
    // Suppression list в send не мутируется (и purge его не удаляет).
    expect(queries.every((q) => !/\b(DELETE|UPDATE)\b/i.test(q.sql))).toBe(true);
    expect(queries.every((q) => !q.sql.includes('retention_email_unsubscribes'))).toBe(true);
    // Лог — safe-форма: без идентификаторов и сырых сообщений об ошибках.
    const logs = JSON.stringify(svc.logger.warn.mock.calls);
    expect(logs).not.toContain('u-gone');
    expect(logs).not.toContain('u-live');
  });

  it('удалённый SMS-получатель не получает сообщение', async () => {
    const { svc, tags } = sendHarness({
      active: ['u-sms-live'],
      drafts: [
        draft({ user_id: 'u-sms-live', email: null, phone: '10000000001', channel: 'sms' }),
        draft({ user_id: 'u-sms-gone', email: null, phone: '10000000002', channel: 'sms' }),
      ],
    });

    const out = await svc.sendRetentionOutreach({ confirm: true });

    expect(out).toMatchObject({ sent: 1, sent_sms: 1 });
    expect(svc.sendOutreachSms).toHaveBeenCalledTimes(1);
    expect(svc.sendOutreachSms.mock.calls[0][0]).toBe('10000000001');
    expect(tags).toEqual(['check', 'sms', 'event', 'check']);
  });

  it('ошибка проверки — fail-closed: транспорт не вызван, безопасный код active_check_failed', async () => {
    const { svc } = sendHarness({
      active: [],
      checkFails: true,
      drafts: [draft({ user_id: 'u-live', email: 'live@example.test', channel: 'email' })],
    });

    const out = await svc.sendRetentionOutreach({ confirm: true });

    expect(out.results[0]).toMatchObject({ status: 'failed', error: 'active_check_failed' });
    expect(svc.mail.send).not.toHaveBeenCalled();
    expect(svc.sendOutreachSms).not.toHaveBeenCalled();
    const logs = JSON.stringify(svc.logger.warn.mock.calls);
    expect(logs).toContain('active_check_failed');
    expect(logs).not.toContain('db down');
    expect(logs).not.toContain('u-live');
  });

  it('живой получатель отправляется как раньше (гейт не блокирует active)', async () => {
    const { svc } = sendHarness({
      active: ['u-live'],
      drafts: [draft({ user_id: 'u-live', email: 'live@example.test', channel: 'email' })],
    });

    const out = await svc.sendRetentionOutreach({ confirm: true });

    expect(out).toMatchObject({ sent: 1, failed: 0 });
    expect(svc.mail.send).toHaveBeenCalledTimes(1);
  });
});
