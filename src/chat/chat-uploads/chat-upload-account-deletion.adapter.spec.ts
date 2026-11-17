import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'fs';
import { AccountDeletionModule } from '../../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  DeletionRetryError,
  safeDeletionJobSnapshot,
} from '../../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../../account-deletion/account-deletion.types';
import { ChatUploadsModule } from './chat-uploads.module';
import {
  ChatUploadAccountDeletionAdapter,
  CHAT_UPLOAD_RESOURCE_KEY,
  discoverChatUploads,
} from './chat-upload-account-deletion.adapter';

/**
 * chat_uploads при удалении аккаунта (Phase 2): исходники загрузок стираются
 * ЧЕРЕЗ КОНВЕЙЕР (chat-upload.purge, фаза purge — загрузки переживают
 * 30-дневное окно реактивации, как chat-file.purge), а не inline-вызовом из
 * deleteProfile: inline минул бы fencing (реактивация/merge пропускали бы
 * очистку).
 *
 * Контракт:
 *  - discovery: есть строки chat_uploads пользователя — ОДНА задача
 *    (resourceKey статический, payload пустой — ключи не снапшотятся);
 *    нет строк — плана нет;
 *  - execute: storage_key'и читаются ИЗ ТАБЛИЦЫ в момент исполнения (таблицу
 *    никто кроме этого адаптера не стирает — гонки нет), на каждый ключ —
 *    оригинал, thumb_key и вычисляемый thumbs/<storage_key>.webp (миграция
 *    002; миниатюра могла лечь и при thumb_key = NULL) —
 *    deleteConfirmed (подтверждённый исход или absent = успех), затем строки
 *    удаляются; любой неизвестный исход MinIO — DeletionRetryError, строки
 *    СОХРАНЯЮТСЯ для retry (fail-closed: storage_key — единственный указатель
 *    на байты);
 *  - идемпотентность: повторный прогон после частичного сбоя безопасен.
 */

const BUCKET = 'linkeon-chat-uploads';
const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const account: DeletionAccount = {
  userId: 'u-deleted',
  deletionId,
  deletedAt: new Date('2026-11-11T00:00:00Z'),
};
const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/отчёт.pdf';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/photo (1).png';

/**
 * Фейковая БД: повторяет семантику SQL адаптера (existence-check discovery,
 * чтение ключей, удаление строк). Настоящий SQL — в pg-спеке.
 */
class FakeUploadsDb {
  rows: Array<{ user_id: string; storage_key: string; thumb_key?: string | null }> = [];
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });
    if (s.startsWith('SELECT 1 FROM chat_uploads')) {
      const userId = String(params[0]);
      const hit = this.rows.some((r) => r.user_id === userId);
      return { rows: hit ? [{ n: 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (s.startsWith('SELECT storage_key, thumb_key FROM chat_uploads')) {
      const userId = String(params[0]);
      const rows = this.rows
        .filter((r) => r.user_id === userId)
        .map((r) => ({ storage_key: r.storage_key, thumb_key: r.thumb_key ?? null }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('DELETE FROM chat_uploads')) {
      const userId = String(params[0]);
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => r.user_id !== userId);
      return { rows: [], rowCount: before - this.rows.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  deleteQueries(): string[] {
    return this.queries.filter((q) => q.sql.startsWith('DELETE FROM chat_uploads')).map((q) => q.sql);
  }
}

function makeStorage() {
  return {
    deleteConfirmed: jest.fn(
      async (_input: { bucket: string; key: string }): Promise<'deleted' | 'absent'> => 'deleted',
    ),
    delete: jest.fn(async (_input: { bucket: string; key: string }): Promise<void> => undefined),
  };
}

function makeHarness() {
  const db = new FakeUploadsDb();
  const storage = makeStorage();
  const registry = new AccountDeletionRegistry();
  const adapter = new ChatUploadAccountDeletionAdapter(storage as any, registry);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = {
    db,
    assertCurrent: jest.fn(async (_job: DeletionJobRow): Promise<void> => undefined),
  };
  return { db, storage, registry, adapter, ctx };
}

function purgeJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-chat-upload-1',
    deletionId,
    userId: account.userId,
    resourceType: 'chat-upload.purge',
    resourceKey: CHAT_UPLOAD_RESOURCE_KEY,
    phase: 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-11T00:00:00Z'),
    leaseUntil: new Date('2026-12-11T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

describe('discoverChatUploads — одна purge-задача при наличии строк', () => {
  it('строки есть: ровно один job chat-upload.purge, phase purge, payload пустой', async () => {
    const { db, storage } = makeHarness();
    db.rows.push(
      { user_id: 'u-deleted', storage_key: KEY_A },
      { user_id: 'u-deleted', storage_key: KEY_B },
      { user_id: 'u-other', storage_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/чужой.pdf' },
    );

    const plan = await discoverChatUploads({ db, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]).toEqual({
      resourceType: 'chat-upload.purge',
      resourceKey: CHAT_UPLOAD_RESOURCE_KEY,
      phase: 'purge',
      payload: {},
    });
    expect(plan.skips).toEqual([]);
    // Existence-check, а не снапшот ключей в payload.
    const existence = db.queries.filter((q) => q.sql.startsWith('SELECT 1 FROM chat_uploads'));
    expect(existence).toHaveLength(1);
    expect(existence[0].params).toEqual(['u-deleted']);
    expect(existence[0].sql).toMatch(/LIMIT 1/);
    // Discovery ничего не удаляет.
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.deleteQueries()).toEqual([]);
  });

  it('строк нет — плана нет', async () => {
    const { db } = makeHarness();
    db.rows.push({ user_id: 'u-other', storage_key: KEY_A });

    const plan = await discoverChatUploads({ db, account, origin: 'merge' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });

  it('job проходит fail-closed sanitizer (safeDeletionJobSnapshot)', () => {
    const snapshot = safeDeletionJobSnapshot(purgeJob(), account.userId);
    expect(snapshot.resourceType).toBe('chat-upload.purge');
    expect(snapshot.phase).toBe('purge');
    expect(snapshot.payloadJson).toBe('{}');
  });
});

describe('ChatUploadAccountDeletionAdapter — purge', () => {
  it('удаляет каждый объект через deleteConfirmed, затем строки; assertCurrent на каждом шаге', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push(
      { user_id: 'u-deleted', storage_key: KEY_A },
      { user_id: 'u-deleted', storage_key: KEY_B },
      { user_id: 'u-other', storage_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/чужой.pdf' },
    );
    const job = purgeJob();

    await adapter.execute(job, ctx);

    const deleted: Array<[string, string]> = storage.deleteConfirmed.mock.calls.map(
      (call: [{ bucket: string; key: string }]) => [call[0].bucket, call[0].key],
    );
    // thumb_key у строк нет (NULL), но миниатюра стирается и по вычисляемому
    // ключу thumbs/<storage_key>.webp: она могла лечь в бакет при
    // неоднозначном сбое сохранения, когда thumb_key не записался.
    expect(deleted).toEqual([
      [BUCKET, KEY_A],
      [BUCKET, `thumbs/${KEY_A}.webp`],
      [BUCKET, KEY_B],
      [BUCKET, `thumbs/${KEY_B}.webp`],
    ]);
    // Строки удалены ПОСЛЕ объектов (storage_key — единственный указатель на байты).
    expect(db.deleteQueries()).toHaveLength(1);
    expect(db.rows.some((r) => r.user_id === 'u-deleted')).toBe(false);
    // Чужие строки не тронуты.
    expect(db.rows.some((r) => r.user_id === 'u-other')).toBe(true);
    // assertCurrent: до чтения ключей, перед каждым объектом и перед DELETE.
    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of ctx.assertCurrent.mock.calls) {
      expect((call as [DeletionJobRow])[0]).toBe(job);
    }
  });

  it('неизвестный исход MinIO (503) — retry, строки НЕ удалены', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A });
    storage.deleteConfirmed.mockRejectedValue({ response: { status: 503 } });

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toBeInstanceOf(DeletionRetryError);
    await expect(adapter.execute(purgeJob(), ctx)).rejects.toMatchObject({ kind: 'external_5xx' });
    expect(db.deleteQueries()).toEqual([]);
    expect(db.rows).toHaveLength(1);
  });

  it('timeout — retry kind timeout, payload и строки сохранены', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A });
    storage.deleteConfirmed.mockRejectedValue({ code: 'ETIMEDOUT' });
    const job = purgeJob();

    await expect(adapter.execute(job, ctx)).rejects.toMatchObject({ kind: 'timeout' });
    expect(job.payload).toEqual({});
    expect(job.resourceKey).toBe(CHAT_UPLOAD_RESOURCE_KEY);
    expect(db.deleteQueries()).toEqual([]);
  });

  it('объект уже отсутствует (absent) — подтверждённый успех, строки удалены', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A });
    storage.deleteConfirmed.mockResolvedValue('absent');

    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.deleteQueries()).toHaveLength(1);
    expect(db.rows).toEqual([]);
  });

  it('повторный прогон после частичного сбоя идемпотентен', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push(
      { user_id: 'u-deleted', storage_key: KEY_A },
      { user_id: 'u-deleted', storage_key: KEY_B },
    );
    // Первый объект удалён, второй — сбой.
    storage.deleteConfirmed
      .mockResolvedValueOnce('deleted')
      .mockRejectedValueOnce({ response: { status: 500 } });
    await expect(adapter.execute(purgeJob(), ctx)).rejects.toMatchObject({ kind: 'external_5xx' });
    expect(db.rows).toHaveLength(2); // строки сохранены для retry

    // Повтор: MinIO отвечает absent для уже стёртого объекта — успех.
    storage.deleteConfirmed.mockReset();
    storage.deleteConfirmed.mockResolvedValue('absent');
    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.rows).toEqual([]);
  });

  it('реактивация посреди purge — assertCurrent отменяет job до deleteConfirmed', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A });
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.deleteQueries()).toEqual([]);
  });

  it('DeletionCancelledError из deleteConfirmed прокидывается как есть, а не как retry', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A });
    storage.deleteConfirmed.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.deleteQueries()).toEqual([]);
  });

  it('аномальный storage_key (traversal/пусто) — fail-closed retry kind db, удалений нет', async () => {
    for (const bad of ['../etc/passwd', 'a//b', '', '.', 'x/./y']) {
      const { db, adapter, ctx, storage } = makeHarness();
      db.rows.push({ user_id: 'u-deleted', storage_key: bad });

      await expect(adapter.execute(purgeJob(), ctx)).rejects.toBeInstanceOf(DeletionRetryError);
      await expect(adapter.execute(purgeJob(), ctx)).rejects.toMatchObject({ kind: 'db' });
      expect(storage.deleteConfirmed).not.toHaveBeenCalled();
      expect(db.deleteQueries()).toEqual([]);
    }
  });

  it('пустая таблица к моменту исполнения — успех без deleteConfirmed (идемпотентно)', async () => {
    const { db, adapter, ctx, storage } = makeHarness();

    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.deleteQueries()).toHaveLength(1);
  });

  it('неподдерживаемый resourceType отклоняется', async () => {
    const { adapter, ctx } = makeHarness();
    const foreign = { ...purgeJob(), resourceType: 'chat-file.purge' as const };
    await expect(adapter.execute(foreign, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });

  it('purge не использует StorageService.delete напрямую (только deleteConfirmed)', () => {
    const src = readFileSync(
      `${__dirname}/chat-upload-account-deletion.adapter.ts`,
      'utf8',
    );
    expect(src).not.toMatch(/storage\.delete\(/);
    expect(src).toContain('deleteConfirmed');
  });

  it('resourceTypes — только chat-upload.purge, registry регистрируется один раз', () => {
    const { adapter, registry } = makeHarness();
    expect(adapter.resourceTypes).toEqual(['chat-upload.purge']);
    const register = jest.spyOn(registry, 'register');
    adapter.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(adapter);
    expect(registry.getExecutor('chat-upload.purge')).toBe(adapter);
  });

  it('ChatUploadsModule подключает AccountDeletionModule и адаптер ровно один раз', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatUploadsModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChatUploadsModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === ChatUploadAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverChatUploads ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverChatUploads),
    ).toHaveLength(1);
  });
});

describe('ChatUploadAccountDeletionAdapter — миниатюры (thumb_key, миграция 002)', () => {
  const THUMB_A = `thumbs/${KEY_A}.webp`;
  const THUMB_B = `thumbs/${KEY_B}.webp`;
  const OTHER_KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/чужой.png';

  it('миниатюра стирается вместе с оригиналом; строки — после всех объектов, чужие целы', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push(
      { user_id: 'u-deleted', storage_key: KEY_A, thumb_key: THUMB_A },
      { user_id: 'u-deleted', storage_key: KEY_B, thumb_key: null },
      { user_id: 'u-other', storage_key: OTHER_KEY, thumb_key: `thumbs/${OTHER_KEY}.webp` },
    );

    await adapter.execute(purgeJob(), ctx);

    const deleted: Array<[string, string]> = storage.deleteConfirmed.mock.calls.map(
      (call: [{ bucket: string; key: string }]) => [call[0].bucket, call[0].key],
    );
    // A: thumb_key совпадает с вычисляемым ключом — один вызов на миниатюру.
    // B: thumb_key NULL — вычисляемый ключ стирается всё равно (миниатюра
    // могла лечь при неоднозначном сбое сохранения).
    expect(deleted).toEqual([
      [BUCKET, KEY_A],
      [BUCKET, THUMB_A],
      [BUCKET, KEY_B],
      [BUCKET, THUMB_B],
    ]);
    expect(db.deleteQueries()).toHaveLength(1);
    expect(db.rows.some((r) => r.user_id === 'u-deleted')).toBe(false);
    expect(db.rows.some((r) => r.user_id === 'u-other')).toBe(true);
    // assertCurrent: до чтения ключей, перед каждым из четырёх объектов и перед DELETE.
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(6);
  });

  it('thumb_key не совпадает с вычисляемым — стираются оба ключа миниатюры', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    const legacyThumb = 'thumbs/legacy/aaaa.webp';
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A, thumb_key: legacyThumb });

    await adapter.execute(purgeJob(), ctx);

    const keys = storage.deleteConfirmed.mock.calls.map(
      (call: [{ bucket: string; key: string }]) => call[0].key,
    );
    expect(keys).toEqual([KEY_A, legacyThumb, THUMB_A]);
    expect(db.rows).toEqual([]);
  });

  it('сбой удаления миниатюры — retry, строки сохранены (указатель на миниатюру не теряется)', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A, thumb_key: THUMB_A });
    storage.deleteConfirmed
      .mockResolvedValueOnce('deleted')
      .mockRejectedValueOnce({ response: { status: 503 } });

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toMatchObject({ kind: 'external_5xx' });
    expect(db.deleteQueries()).toEqual([]);
    expect(db.rows).toHaveLength(1);
  });

  it('миниатюры уже нет (absent) — подтверждённый успех, строки удалены', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A, thumb_key: THUMB_A });
    storage.deleteConfirmed.mockResolvedValueOnce('deleted').mockResolvedValueOnce('absent');

    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(2);
    expect(db.rows).toEqual([]);
  });

  it('аномальный thumb_key — fail-closed retry kind db, ни одного удаления (даже оригинала)', async () => {
    for (const bad of ['../etc/passwd', 'thumbs//x.webp', '', '.', 'thumbs/./x.webp']) {
      const { db, adapter, ctx, storage } = makeHarness();
      db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A, thumb_key: bad });

      await expect(adapter.execute(purgeJob(), ctx)).rejects.toBeInstanceOf(DeletionRetryError);
      await expect(adapter.execute(purgeJob(), ctx)).rejects.toMatchObject({ kind: 'db' });
      expect(storage.deleteConfirmed).not.toHaveBeenCalled();
      expect(db.deleteQueries()).toEqual([]);
    }
  });

  it('SELECT адаптера читает thumb_key вместе со storage_key', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.rows.push({ user_id: 'u-deleted', storage_key: KEY_A });

    await adapter.execute(purgeJob(), ctx);

    const selects = db.queries.filter((q) => q.sql.startsWith('SELECT storage_key'));
    expect(selects).toHaveLength(1);
    expect(selects[0].sql).toBe('SELECT storage_key, thumb_key FROM chat_uploads WHERE user_id = $1');
    expect(selects[0].params).toEqual(['u-deleted']);
  });
});
