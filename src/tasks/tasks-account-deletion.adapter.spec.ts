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
import { TasksModule } from './tasks.module';
import { TasksService } from './tasks.service';
import {
  discoverTasksDeletion,
  TasksAccountDeletionAdapter,
} from './tasks-account-deletion.adapter';

/**
 * Task 17A — tasks: немедленная остановка и delayed purge.
 *
 * tasks.stop архивирует активные задачи удалённого поколения (archived —
 * статус из CHECK схемы 001_tasks.sql). tasks.purge удаляет строки tasks
 * целиком; task_events исчезает существующим FK ON DELETE CASCADE
 * (001_tasks.sql:32) — отдельного SQL для событий нет.
 *
 * Extract-поток (TasksService.extractFromTurn) для неактивного аккаунта
 * запрещён: state-гейт ДО listActive/askLLMForDecision (LLM не вызывается —
 * платный внешний вызов для аккаунта, которого нет) и ПОВТОРНО до
 * applyDecision — между ними асинхронный LLM-вызов, аккаунт могут удалить
 * в процессе (паттерн voice-avatar.service.ts profileAndClone).
 *
 * Отклонение от сниппета плана: сообщение «личный вопрос» срезал бы
 * существующий shouldSkipTaskExtraction (короткое, без проектных ключевых
 * слов) и тест не проверял бы гейт — используется сообщение, проходящее
 * prefilter. LLM-мок — ClaudeCliService.text (реальная точка входа LLM
 * в tasks.service.ts); настоящий LLM не вызывается.
 */

const USER = 'u-deleted';
const OTHER = 'u-other';
const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OTHER_GENERATION = '11111111-2222-4333-8444-555555555555';
/** Проходит shouldSkipTaskExtraction: длиннее 25 символов, проектные слова. */
const TASK_MESSAGE = 'нужно обсудить запуск Telegram-бота, дедлайн в пятницу';
const OWN_CANARY = 'КАНАРЕЙКА-ЛИЧНЫЙ-ТЕКСТ';

interface TaskDbRow {
  id: string;
  user_id: string;
  title: string;
  summary: string;
  claudemd: string;
  claudemd_locked: boolean;
  status: 'active' | 'archived' | 'done';
  embedding: number[] | null;
}

interface TaskEventDbRow {
  id: number;
  task_id: string;
  kind: string;
  content: string;
  agent_id: number | null;
}

function dbError(): Error {
  // SQLSTATE 08006 (connection_failure) → deletionErrorKind = 'db'.
  return Object.assign(new Error('connection terminated'), { code: '08006' });
}

/**
 * Фейковая БД: повторяет SQL-семантику адаптера и сервиса (generation gate,
 * active gate, scoped UPDATE/DELETE, FK CASCADE tasks → task_events).
 * Неизвестный запрос — throw. Журнал calls хранит порядок операций.
 */
class FakeTasksDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  tasks: TaskDbRow[] = [];
  taskEvents: TaskEventDbRow[] = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  readonly calls: string[] = [];
  /** Отказ пишущих SQL — проверка обёртки DeletionRetryError. */
  failWrites = false;
  private nextTaskNum = 1;
  private nextEventId = 1;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

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
    if (s.startsWith('SELECT * FROM tasks')) {
      // listActive: свои активные.
      const [userId] = params as [string];
      const rows = this.tasks.filter((t) => t.user_id === String(userId) && t.status === 'active');
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT id, claudemd_locked FROM tasks')) {
      const [taskId, userId] = params as [string, string];
      const rows = this.tasks
        .filter((t) => t.id === String(taskId) && t.user_id === String(userId))
        .map((t) => ({ id: t.id, claudemd_locked: t.claudemd_locked }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT title, summary, claudemd FROM tasks')) {
      const [taskId] = params as [string];
      const rows = this.tasks.filter((t) => t.id === String(taskId));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('UPDATE tasks')) {
      if (this.failWrites) throw dbError();
      if (s.includes(`SET status='archived'`)) {
        // tasks.stop: скоуп user_id + status='active', EXISTS-гейт поколения.
        const [userId, genId] = params as [string, string];
        if (!this.isCurrentDeletion(String(userId), String(genId))) {
          return { rows: [], rowCount: 0 };
        }
        let n = 0;
        for (const t of this.tasks) {
          if (t.user_id === String(userId) && t.status === 'active') {
            t.status = 'archived';
            n += 1;
          }
        }
        this.calls.push('db.stopTasks');
        return { rows: [], rowCount: n };
      }
      // append-ветвь applyDecision: UPDATE tasks SET ... WHERE id = $N.
      const id = String(params[params.length - 1]);
      const task = this.tasks.find((t) => t.id === id);
      return { rows: [], rowCount: task ? 1 : 0 };
    }
    if (s.startsWith('DELETE FROM tasks')) {
      if (this.failWrites) throw dbError();
      // tasks.purge: scoped DELETE под generation predicate.
      const [userId, genId] = params as [string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const removed = this.tasks.filter((t) => t.user_id === String(userId));
      const ids = new Set(removed.map((t) => t.id));
      this.tasks = this.tasks.filter((t) => !ids.has(t.id));
      // FK task_events.task_id → tasks(id) ON DELETE CASCADE (001_tasks.sql:32).
      this.taskEvents = this.taskEvents.filter((e) => !ids.has(e.task_id));
      this.calls.push('db.purgeTasks');
      return { rows: [], rowCount: removed.length };
    }
    if (s.startsWith('INSERT INTO tasks')) {
      if (this.failWrites) throw dbError();
      const [userId, title, summary, claudemd, embedding] = params as any[];
      const row: TaskDbRow = {
        id: `task-${this.nextTaskNum++}`,
        user_id: String(userId),
        title: String(title),
        summary: String(summary),
        claudemd: String(claudemd),
        claudemd_locked: false,
        status: 'active',
        embedding: (embedding ?? null) as number[] | null,
      };
      this.tasks.push(row);
      this.calls.push('db.insertTask');
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO task_events')) {
      if (this.failWrites) throw dbError();
      const kind = /'(user_message|agent_response|note|milestone|decision|status_change)'/.exec(s)?.[1] ?? 'note';
      const [taskId, content, agentId] = params as [string, string, number | null];
      this.taskEvents.push({
        id: this.nextEventId++,
        task_id: String(taskId),
        kind,
        content: String(content),
        agent_id: agentId ?? null,
      });
      this.calls.push('db.insertTaskEvent');
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }
}

function makeHarness() {
  const db = new FakeTasksDb();
  db.users.set(USER, { state: 'deleted', deletionId });
  db.users.set(OTHER, { state: 'active', deletionId: null });
  const registry = new AccountDeletionRegistry();
  const adapter = new TasksAccountDeletionAdapter(registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, registry, adapter, ctx };
}

function tasksJob(resourceType: 'tasks.stop' | 'tasks.purge', overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: `job-${resourceType}`,
    deletionId,
    userId: USER,
    resourceType,
    resourceKey: 'tasks',
    phase: resourceType === 'tasks.stop' ? 'immediate' : 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-14T00:00:00Z'),
    leaseUntil: new Date('2026-11-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

function ownTask(id: string, overrides: Partial<TaskDbRow> = {}): TaskDbRow {
  return {
    id,
    user_id: USER,
    title: 'Запуск бота',
    summary: OWN_CANARY,
    claudemd: 'инструкция',
    claudemd_locked: false,
    status: 'active',
    embedding: null,
    ...overrides,
  };
}

function makeTasksService(db: FakeTasksDb) {
  const claude = { text: jest.fn(async () => '{"action":"none"}') };
  const service = new TasksService(db as any, claude as any);
  return { service, claude };
}

describe('discoverTasksDeletion — stop immediate + purge (Task 17A)', () => {
  it('два job: tasks.stop immediate и tasks.purge; payload {}, ключ без userId', async () => {
    const { db } = makeHarness();

    const plan = await discoverTasksDeletion({
      db,
      account: { userId: USER, deletionId, deletedAt: new Date('2026-11-14T00:00:00Z') },
      origin: 'explicit',
    });

    expect(plan.skips).toEqual([]);
    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[0]).toMatchObject({
      resourceType: 'tasks.stop', resourceKey: 'tasks', phase: 'immediate', payload: {},
    });
    expect(plan.jobs[1]).toMatchObject({
      resourceType: 'tasks.purge', resourceKey: 'tasks', phase: 'purge', payload: {},
    });
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(OWN_CANARY);
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    // Discovery НЕ читает tasks/task_events — только generation gate.
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverTasksDeletion({
      db,
      account: { userId: USER, deletionId, deletedAt: new Date('2026-11-14T00:00:00Z') },
      origin: 'explicit',
    });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('TasksAccountDeletionAdapter.execute — tasks.stop (Task 17A)', () => {
  it('архивирует только собственные active; done/archived/чужие не тронуты', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.tasks.push(
      ownTask('t1'),
      ownTask('t2', { status: 'done' }),
      ownTask('t3', { status: 'archived' }),
      ownTask('t4', { user_id: OTHER }),
    );

    await adapter.execute(tasksJob('tasks.stop'), ctx);

    expect(db.tasks.map((t) => [t.id, t.status])).toEqual([
      ['t1', 'archived'],
      ['t2', 'done'],
      ['t3', 'archived'],
      ['t4', 'active'],
    ]);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'tasks.stop' }),
    );
  });

  it('generation mismatch — UPDATE матчит 0 строк, тихий успех', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: OTHER_GENERATION });
    db.tasks.push(ownTask('t1'));

    await expect(adapter.execute(tasksJob('tasks.stop'), ctx)).resolves.toBeUndefined();
    expect(db.tasks[0].status).toBe('active');
    expect(db.calls).not.toContain('db.stopTasks');
  });

  it('reactivation до execute — DeletionCancelledError, записей нет', async () => {
    const { db, adapter, ctx } = makeHarness();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());
    db.tasks.push(ownTask('t1'));

    await expect(adapter.execute(tasksJob('tasks.stop'), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.calls).not.toContain('db.stopTasks');
    expect(db.tasks[0].status).toBe('active');
  });

  it('сбой БД — DeletionRetryError(kind db), задачи остаются для retry', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.failWrites = true;
    db.tasks.push(ownTask('t1'));

    await expect(adapter.execute(tasksJob('tasks.stop'), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(db.tasks[0].status).toBe('active');
  });
});

describe('TasksAccountDeletionAdapter.execute — tasks.purge (Task 17A)', () => {
  it('tasks: LLM не вызывается после deleted, purge удаляет events cascade', async () => {
    const { db, adapter, ctx } = makeHarness();
    const { service, claude } = makeTasksService(db);
    db.tasks.push(ownTask('t1'));
    db.taskEvents.push({ id: 1, task_id: 't1', kind: 'milestone', content: OWN_CANARY, agent_id: null });

    await service.extractFromTurn(USER, '1', TASK_MESSAGE, 'личный ответ');
    expect(claude.text).not.toHaveBeenCalled();

    await adapter.execute(tasksJob('tasks.purge'), ctx);
    expect(db.tasks).toHaveLength(0);
    expect(db.taskEvents).toHaveLength(0);
  });

  it('чужие tasks/events сохраняются; canary не уходит ни в один запрос', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.tasks.push(ownTask('t1'), ownTask('t2', { user_id: OTHER, summary: 'чужое' }));
    db.taskEvents.push(
      { id: 1, task_id: 't1', kind: 'note', content: OWN_CANARY, agent_id: null },
      { id: 2, task_id: 't2', kind: 'note', content: 'чужой журнал', agent_id: null },
    );

    await adapter.execute(tasksJob('tasks.purge'), ctx);

    expect(db.tasks).toHaveLength(1);
    expect(db.tasks[0].user_id).toBe(OTHER);
    expect(db.taskEvents).toHaveLength(1);
    expect(db.taskEvents[0].task_id).toBe('t2');
    expect(JSON.stringify(db.queries)).not.toContain(OWN_CANARY);
  });

  it('generation mismatch — DELETE матчит 0 строк, тихий успех', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: OTHER_GENERATION });
    db.tasks.push(ownTask('t1'));

    await expect(adapter.execute(tasksJob('tasks.purge'), ctx)).resolves.toBeUndefined();
    expect(db.tasks).toHaveLength(1);
    expect(db.calls).not.toContain('db.purgeTasks');
  });

  it('идемпотентность: повторный execute — тихий успех', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.tasks.push(ownTask('t1'));

    await adapter.execute(tasksJob('tasks.purge'), ctx);
    await expect(adapter.execute(tasksJob('tasks.purge'), ctx)).resolves.toBeUndefined();
    expect(db.tasks).toHaveLength(0);
  });

  it('сбой БД — DeletionRetryError(kind db)', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.failWrites = true;
    db.tasks.push(ownTask('t1'));

    await expect(adapter.execute(tasksJob('tasks.purge'), ctx)).rejects.toMatchObject({ kind: 'db' });
  });

  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();
    const job = { ...tasksJob('tasks.purge'), resourceType: 'support.purge' as const };

    await expect(adapter.execute(job, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });
});

describe('TasksService.extractFromTurn — state-гейт (Task 17A)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => { delete process.env.OPENAI_API_KEY; });
  afterEach(() => { process.env = { ...savedEnv }; });

  it('deleted: LLM не вызывается, tasks не читаются и не пишутся', async () => {
    const db = new FakeTasksDb();
    db.users.set(USER, { state: 'deleted', deletionId });
    const { service, claude } = makeTasksService(db);

    await expect(service.extractFromTurn(USER, '1', TASK_MESSAGE, 'ответ'))
      .resolves.toBeUndefined();

    expect(claude.text).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.sql.startsWith('SELECT * FROM tasks'))).toBe(false);
    expect(db.calls).not.toContain('db.insertTask');
  });

  it('аккаунт удалён во время LLM-вызова — повторный гейт, решение не применяется', async () => {
    const db = new FakeTasksDb();
    db.users.set(USER, { state: 'active', deletionId: null });
    const claude = {
      text: jest.fn(async () => {
        // Между первым гейтом и applyDecision аккаунт удаляют (commit deletion).
        db.users.set(USER, { state: 'deleted', deletionId });
        return '{"action":"create","title":"Запуск бота","summary":"s","claudemd":"c","firstEventContent":"e"}';
      }),
    };
    const service = new TasksService(db as any, claude as any);

    await service.extractFromTurn(USER, '1', TASK_MESSAGE, 'ответ');

    expect(claude.text).toHaveBeenCalledTimes(1);
    expect(db.tasks).toHaveLength(0);
    expect(db.taskEvents).toHaveLength(0);
    expect(db.calls).not.toContain('db.insertTask');
  });

  it('active: экстракция работает как раньше (create → задача и событие)', async () => {
    const db = new FakeTasksDb();
    db.users.set(USER, { state: 'active', deletionId: null });
    const claude = {
      text: jest.fn(async () => '{"action":"create","title":"Запуск бота","summary":"s","claudemd":"c","firstEventContent":"e"}'),
    };
    const service = new TasksService(db as any, claude as any);

    await service.extractFromTurn(USER, '1', TASK_MESSAGE, 'ответ');

    expect(claude.text).toHaveBeenCalledTimes(1);
    expect(db.tasks).toHaveLength(1);
    expect(db.tasks[0]).toMatchObject({ user_id: USER, title: 'Запуск бота', status: 'active' });
    expect(db.taskEvents).toHaveLength(1);
    expect(db.taskEvents[0]).toMatchObject({ kind: 'milestone', content: 'e' });
  });

  it('сбой state-запроса — fail-closed: LLM не вызывается, ошибки наружу нет', async () => {
    const db = new FakeTasksDb();
    db.users.set(USER, { state: 'active', deletionId: null });
    const original = db.query.bind(db);
    jest.spyOn(db, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      if (String(sql).includes(`state = 'active'`)) throw dbError();
      return original(sql, params ?? []);
    });
    const { service, claude } = makeTasksService(db);

    await expect(service.extractFromTurn(USER, '1', TASK_MESSAGE, 'ответ'))
      .resolves.toBeUndefined();
    expect(claude.text).not.toHaveBeenCalled();
  });
});

describe('wiring tasks.stop/tasks.purge (Task 17A)', () => {
  it('adapter регистрирует оба типа, TasksModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new TasksAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['tasks.stop', 'tasks.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, TasksModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TasksModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === TasksAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverTasksDeletion ровно один раз; purge ждёт stop', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverTasksDeletion),
    ).toHaveLength(1);
    // Порядок stop → purge обеспечивает DEPENDENCY_ELIGIBILITY_SQL в claimNext
    // (account-deletion.jobs.ts): правило allOf при статическом resourceKey
    // 'tasks' эквивалентно sameResourceKey (job по одному на аккаунт).
    expect(DELETION_DEPENDENCIES['tasks.purge']).toEqual({ allOf: ['tasks.stop'] });
  });
});
