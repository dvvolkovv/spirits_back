import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionResourceHash,
  safeDeletionJobSnapshot,
} from '../../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../../account-deletion/account-deletion.types';
import { ChatModule } from '../chat.module';
import { chatFilesBucket } from './chat-file-store';
import { THUMB_BUCKET, thumbKeyFor } from './thumbnails';
import {
  ChatFileAccountDeletionAdapter,
  discoverChatFiles,
} from './chat-file-account-deletion.adapter';
import { readFileSync } from 'fs';

/**
 * Task 11 — chat file refs: исчерпывающий discovery и MinIO purge.
 *
 * История чата удаляется сразу при удалении аккаунта, поэтому технические
 * ссылки на файлы фиксируются job'ами ДО её удаления. В payload живут только
 * MinIO locator (bucket/key) — ни личных текстов, ни userId, ни полных URL
 * с доменом. Объект удаляется только при подтверждённом ЕДИНОЛИЧНОМ
 * владении: ссылка на тот же объект в чужих данных сохраняет объект.
 * Произвольные external URL и файлы релея (/tmp) не удаляются никогда.
 */

const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const account: DeletionAccount = {
  userId: 'u-deleted',
  deletionId,
  deletedAt: new Date('2026-11-11T00:00:00Z'),
};

const ENV = {
  publicBaseUrl: 'https://minio.test',
  agentUrl: 'https://r.test',
  backendUrl: 'https://api.test',
};

const BUCKET = 'linkeon-chat-files';
const FILE_ID = '22222222-2222-4222-8222-222222222222';
const FILE_NAME = 'отчёт.pdf';
const FILE_KEY = `${FILE_ID}/${FILE_NAME}`;
const chatUrl = `${ENV.publicBaseUrl}/${BUCKET}/${FILE_ID}/${encodeURIComponent(FILE_NAME)}`;
const VIDEO_JOB_ID = '11111111-1111-4111-8111-111111111111';
const CLIP_ID = '33333333-3333-4333-8333-333333333333';

interface HistRow {
  id: number;
  session_id: string;
  sender_type?: 'human' | 'ai';
  content: string;
}

/**
 * Фейковая БД: повторяет семантику SQL адаптера (keyset-страницы с generation
 * predicate, ownership маркеров, счётчики ссылок own/external по таблицам).
 * Настоящий SQL исполняется в chat-file-account-deletion.pg.spec.ts.
 */
class FakeChatDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  history: HistRow[] = [];
  videoJobs: Array<{ id: string; user_id: string; video_url?: string | null }> = [];
  speechClips: Array<{ id: string; user_id: string; url?: string | null }> = [];
  generatedImages: Array<{ user_id: string; image_url: string }> = [];
  voiceCalls: Array<{ id: string; user_id: string; transcript?: unknown; summary?: string | null; recording_url?: string | null }> = [];
  voiceCallJobs: Array<{ call_id: string; question: string; answer?: string | null }> = [];
  actionPlans: Array<{ user_id: string; summary?: string | null; items?: unknown }> = [];
  tasks: Array<{ id: string; user_id: string; summary?: string | null; claudemd?: string | null }> = [];
  taskEvents: Array<{ task_id: string; content: string }> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    if (s.startsWith('SELECT h.id, h.content')) {
      const [userId, lastId, genId, pageSize] = params as [string, number, string, number];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const rows = this.history
        .filter((r) => r.session_id.startsWith(`${userId}_`) && r.id > Number(lastId))
        .sort((a, b) => a.id - b.id)
        .slice(0, Number(pageSize));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT 1 FROM video_jobs WHERE id')) {
      const hit = this.videoJobs.some((v) => v.id === params[0] && v.user_id === params[1]);
      return { rows: hit ? [{ n: 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (s.startsWith('SELECT 1 FROM speech_clips WHERE id')) {
      const hit = this.speechClips.some((v) => v.id === params[0] && v.user_id === params[1]);
      return { rows: hit ? [{ n: 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (s.startsWith('SELECT count(*)::int AS total')) {
      const table = /FROM (\w+)/.exec(s)?.[1] ?? '';
      const userId = String(params[0]);
      const needles = params.slice(1).map(String).filter(Boolean);
      let total = 0;
      let own = 0;
      for (const row of this.rowsOf(table)) {
        const hay = this.haystack(row);
        if (!needles.some((n) => hay.includes(n))) continue;
        total += 1;
        if (this.isOwnRow(table, row as any, userId)) own += 1;
      }
      return { rows: [{ total, own }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  private rowsOf(table: string): unknown[] {
    switch (table) {
      case 'custom_chat_history': return this.history;
      case 'generated_images': return this.generatedImages;
      case 'video_jobs': return this.videoJobs;
      case 'speech_clips': return this.speechClips;
      case 'voice_calls': return this.voiceCalls;
      case 'voice_call_jobs': return this.voiceCallJobs;
      case 'action_plans': return this.actionPlans;
      case 'tasks': return this.tasks;
      case 'task_events': return this.taskEvents;
      default: return [];
    }
  }

  private haystack(row: unknown): string {
    const parts: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') parts.push(v);
      else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
    };
    walk(row);
    return parts.join('\n');
  }

  private isOwnRow(table: string, row: any, userId: string): boolean {
    if (table === 'custom_chat_history') return String(row.session_id).startsWith(`${userId}_`);
    if (table === 'voice_call_jobs') {
      return this.voiceCalls.some((c) => c.id === row.call_id && c.user_id === userId);
    }
    if (table === 'task_events') {
      return this.tasks.some((t) => t.id === row.task_id && t.user_id === userId);
    }
    return row.user_id === userId;
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }
}

function makeStorage() {
  return {
    deleteConfirmed: jest.fn(async () => 'deleted' as 'deleted' | 'absent'),
    delete: jest.fn(async () => undefined),
  };
}

function makeHarness() {
  const db = new FakeChatDb();
  db.users.set(account.userId, { state: 'deleted', deletionId });
  const storage = makeStorage();
  const registry = new AccountDeletionRegistry();
  const adapter = new ChatFileAccountDeletionAdapter(storage as any, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, storage, registry, adapter, ctx };
}

function seedHistory(db: FakeChatDb, rows: HistRow[]): void {
  db.history.push(...rows);
}

function purgeJob(payload: Record<string, unknown>, overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-chat-file-1',
    deletionId,
    userId: account.userId,
    resourceType: 'chat-file.purge',
    resourceKey: typeof payload.bucket === 'string' && typeof payload.key === 'string'
      ? deletionResourceHash(payload.bucket, payload.key)
      : 'job-chat-file-1',
    phase: 'purge',
    payload,
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-11T00:00:00Z'),
    leaseUntil: new Date('2026-12-11T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

describe('discoverChatFiles — исчерпывающий snapshot ссылок (Task 11)', () => {
  it('читает human+ai всеми страницами и сохраняет только MinIO locator', async () => {
    const { db, storage } = makeHarness();
    seedHistory(db, [
      { id: 1, session_id: 'u-deleted_a', sender_type: 'human', content: `[VIDEO_JOB:${VIDEO_JOB_ID}]` },
      { id: 2, session_id: 'u-deleted_a', sender_type: 'ai', content: `[Файл](${chatUrl}) ЛИЧНЫЙ-ТЕКСТ` },
      { id: 3, session_id: 'u-deleted_a', sender_type: 'ai', content: '[external](https://example.com/x.mp4)' },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV, pageSize: 1 });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].resourceType).toBe('chat-file.purge');
    expect(plan.jobs[0].phase).toBe('purge');
    expect(plan.jobs[0].resourceKey).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.jobs[0].resourceKey).toBe(deletionResourceHash(BUCKET, FILE_KEY));
    expect(plan.jobs[0].payload).toEqual({ bucket: BUCKET, key: FILE_KEY });
    const payloadJson = JSON.stringify(plan.jobs[0].payload);
    expect(payloadJson).not.toContain('ЛИЧНЫЙ-ТЕКСТ');
    expect(payloadJson).not.toContain('u-deleted');
    expect(payloadJson).not.toContain('minio.test');
    expect(payloadJson).not.toContain('example.com');
    // Discovery ничего не удаляет.
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('keyset-пагинация без limit 5000: каждая страница читается до пустой', async () => {
    const { db } = makeHarness();
    for (let i = 1; i <= 7; i += 1) {
      seedHistory(db, [{
        id: i,
        session_id: 'u-deleted_a',
        content: `[Файл ${i}](${ENV.publicBaseUrl}/${BUCKET}/id-${i}/f${i}.pdf)`,
      }]);
    }

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV, pageSize: 2 });

    expect(plan.jobs).toHaveLength(7);
    const pageQueries = db.queries.filter((q) => q.sql.startsWith('SELECT h.id, h.content'));
    // 7 строк по 2 + пустая замыкающая страница.
    expect(pageQueries.length).toBeGreaterThanOrEqual(4);
    expect(pageQueries.every((q) => !/LIMIT 5000|5000/.test(q.sql))).toBe(true);
  });

  it('повтор той же ссылки в двух строках — один job (дедуп по locator)', async () => {
    const { db } = makeHarness();
    seedHistory(db, [
      { id: 1, session_id: 'u-deleted_a', content: `[Файл](${chatUrl})` },
      { id: 2, session_id: 'u-deleted_b', content: `и снова [Файл](${chatUrl})` },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });

    expect(plan.jobs).toHaveLength(1);
  });

  it('маркер video_job: чужой/несуществующий — skip owner_unverifiable, свой — делегируется без job', async () => {
    const { db } = makeHarness();
    seedHistory(db, [
      { id: 1, session_id: 'u-deleted_a', content: `[VIDEO_JOB:${VIDEO_JOB_ID}]` },
    ]);
    const foreign = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });
    expect(foreign.jobs).toEqual([]);
    expect(foreign.skips).toEqual([
      { resourceType: 'chat-file.purge', reason: 'owner_unverifiable' },
    ]);

    // Свой video_jobs: объект чистит Task 12 (video-job.purge) по строке —
    // chat-file job не дублирует его, skip не нужен.
    db.videoJobs.push({ id: VIDEO_JOB_ID, user_id: 'u-deleted' });
    const owned = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });
    expect(owned.jobs).toEqual([]);
    expect(owned.skips).toEqual([]);
  });

  it('маркер audio_clip проверяется через speech_clips.id + user_id', async () => {
    const { db } = makeHarness();
    seedHistory(db, [
      { id: 1, session_id: 'u-deleted_a', content: `{{audio:id=${CLIP_ID}}}` },
    ]);
    const foreign = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });
    expect(foreign.jobs).toEqual([]);
    expect(foreign.skips).toEqual([
      { resourceType: 'chat-file.purge', reason: 'owner_unverifiable' },
    ]);

    db.speechClips.push({ id: CLIP_ID, user_id: 'u-deleted' });
    const owned = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });
    expect(owned.jobs).toEqual([]);
    expect(owned.skips).toEqual([]);
    const ownership = db.queries.filter((q) => q.sql.startsWith('SELECT 1 FROM speech_clips WHERE id'));
    expect(ownership.length).toBeGreaterThan(0);
    expect(ownership[0].params).toEqual([CLIP_ID, 'u-deleted']);
  });

  it('relay /tmp, /static/ и произвольные external URL в план не попадают', async () => {
    const { db } = makeHarness();
    seedHistory(db, [
      { id: 1, session_id: 'u-deleted_a', content: '[relay](https://r.test/files/tmp/agent-output/a/b.pdf)' },
      { id: 2, session_id: 'u-deleted_a', content: '![img](https://api.test/static/generated/u/pic.png)' },
      { id: 3, session_id: 'u-deleted_a', content: '[other minio](https://minio.test/linkeon-smm-videos/v/clip.mp4)' },
      { id: 4, session_id: 'u-deleted_a', content: 'https://cdn.example.com/pic.png' },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });

    expect(plan.jobs).toEqual([]);
  });

  it('generation predicate: чужой deletionId или живой аккаунт — план пустой', async () => {
    const { db } = makeHarness();
    seedHistory(db, [{ id: 1, session_id: 'u-deleted_a', content: `[Файл](${chatUrl})` }]);

    const stale = await discoverChatFiles({
      db,
      account: { ...account, deletionId: '55555555-5555-4555-8555-555555555555' },
      origin: 'explicit',
      env: ENV,
    });
    expect(stale.jobs).toEqual([]);

    db.users.set(account.userId, { state: 'active', deletionId: null });
    const reactivated = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });
    expect(reactivated.jobs).toEqual([]);
  });

  it('чужая сессия с похожим префиксом не читается', async () => {
    const { db } = makeHarness();
    seedHistory(db, [
      { id: 1, session_id: 'u-deletedX_a', content: `[Файл](${chatUrl})` },
      { id: 2, session_id: 'u-deleted2_a', content: `[Файл](${ENV.publicBaseUrl}/${BUCKET}/x/y.pdf)` },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });

    expect(plan.jobs).toEqual([]);
  });

  it('payload проходит fail-closed sanitizer (safeDeletionJobSnapshot)', () => {
    const snapshot = safeDeletionJobSnapshot({
      resourceType: 'chat-file.purge',
      resourceKey: deletionResourceHash(BUCKET, FILE_KEY),
      phase: 'purge',
      payload: { bucket: BUCKET, key: FILE_KEY },
    }, account.userId);
    expect(snapshot.payloadJson).toBe(JSON.stringify({ bucket: BUCKET, key: FILE_KEY }));
  });
});

describe('ChatFileAccountDeletionAdapter — purge (Task 11)', () => {
  const locator = { bucket: BUCKET, key: FILE_KEY };

  it('единственный владелец: объект и миниатюра удалены, assertCurrent до каждого delete', async () => {
    const { adapter, ctx, storage } = makeHarness();
    const job = purgeJob({ bucket: BUCKET, key: `${FILE_ID}/photo.PNG` });

    await adapter.execute(job, ctx);

    expect(storage.deleteConfirmed).toHaveBeenCalledWith({
      bucket: BUCKET, key: `${FILE_ID}/photo.PNG`,
    });
    expect(storage.deleteConfirmed).toHaveBeenCalledWith({
      bucket: THUMB_BUCKET,
      key: thumbKeyFor({ bucket: BUCKET, key: `${FILE_ID}/photo.PNG` }),
    });
    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of ctx.assertCurrent.mock.calls) expect(call[0]).toBe(job);
  });

  it('не-картинка: миниатюра не удаляется', async () => {
    const { adapter, ctx, storage } = makeHarness();

    await adapter.execute(purgeJob(locator), ctx);

    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(1);
    expect(storage.deleteConfirmed).toHaveBeenCalledWith(locator);
  });

  it('URL того же объекта в истории u-other — объект сохраняется, job успешен', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.history.push({
      id: 99,
      session_id: 'u-other_a',
      content: `[Файл](${ENV.publicBaseUrl}/${BUCKET}/${FILE_ID}/${encodeURIComponent(FILE_NAME)})`,
    });

    await expect(adapter.execute(purgeJob(locator), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('ссылка в чужой tasks/voice_call_jobs/generated_images — объект сохраняется', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.generatedImages.push({ user_id: 'u-other', image_url: `${ENV.publicBaseUrl}/${BUCKET}/${FILE_KEY}` });

    await expect(adapter.execute(purgeJob(locator), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('ссылка в СОБСТВЕННОЙ строке удалённого аккаунта — retry, объект не удалён', async () => {
    const { db, adapter, ctx, storage } = makeHarness();
    db.generatedImages.push({ user_id: 'u-deleted', image_url: `${ENV.publicBaseUrl}/${BUCKET}/${FILE_KEY}` });

    await expect(adapter.execute(purgeJob(locator), ctx)).rejects.toBeInstanceOf(DeletionRetryError);
    await expect(adapter.execute(purgeJob(locator), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('MinIO timeout — retry с kind timeout, payload и job сохранены', async () => {
    const { adapter, ctx, storage } = makeHarness();
    storage.deleteConfirmed.mockRejectedValue({ code: 'ETIMEDOUT' });
    const job = purgeJob(locator);

    await expect(adapter.execute(job, ctx)).rejects.toBeInstanceOf(DeletionRetryError);
    await expect(adapter.execute(job, ctx)).rejects.toMatchObject({ kind: 'timeout' });
    // Технический locator не потерян — retry знает, что удалять.
    expect(job.payload).toEqual({ bucket: BUCKET, key: FILE_KEY });
    expect(job.resourceKey).toBe(deletionResourceHash(BUCKET, FILE_KEY));
  });

  it('объект уже отсутствует (absent) — подтверждённый успех, повтор идемпотентен', async () => {
    const { adapter, ctx, storage } = makeHarness();
    storage.deleteConfirmed.mockResolvedValue('absent');

    await expect(adapter.execute(purgeJob(locator), ctx)).resolves.toBeUndefined();
    await expect(adapter.execute(purgeJob(locator), ctx)).resolves.toBeUndefined();
  });

  it('неизвестный исход MinIO — retry, а не успех', async () => {
    const { adapter, ctx, storage } = makeHarness();
    storage.deleteConfirmed.mockRejectedValue({ response: { status: 503 } });

    await expect(adapter.execute(purgeJob(locator), ctx)).rejects.toMatchObject({ kind: 'external_5xx' });
  });

  it('reactivation посреди purge — assertCurrent отменяет job до delete', async () => {
    const { adapter, ctx, storage } = makeHarness();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(purgeJob(locator), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('payload вне бакета chat files и «..» в ключе отклоняются без delete', async () => {
    const { adapter, ctx, storage } = makeHarness();

    await expect(adapter.execute(
      purgeJob({ bucket: BUCKET, key: '../etc/passwd' }),
      ctx,
    )).rejects.toBeInstanceOf(DeletionRetryError);
    await expect(adapter.execute(
      purgeJob({ bucket: 'linkeon-assets', key: 'avatars/users/x.jpg' }),
      ctx,
    )).rejects.toBeInstanceOf(DeletionRetryError);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('неподдерживаемый resourceType отклоняется', async () => {
    const { adapter, ctx } = makeHarness();
    const foreign = { ...purgeJob(locator), resourceType: 'image.purge' as const };
    await expect(adapter.execute(foreign, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });

  it('resourceTypes — только chat-file.purge, registry регистрируется один раз', () => {
    const { adapter, registry } = makeHarness();
    expect(adapter.resourceTypes).toEqual(['chat-file.purge']);
    const register = jest.spyOn(registry, 'register');
    adapter.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(adapter);
    expect(registry.getExecutor('chat-file.purge')).toBe(adapter);
  });

  it('purge не использует StorageService.delete напрямую (только deleteConfirmed)', () => {
    const src = readFileSync(`${__dirname}/chat-file-account-deletion.adapter.ts`, 'utf8');
    expect(src).not.toMatch(/storage\.delete\(/);
    expect(src).toContain('deleteConfirmed');
  });

  it('ChatModule подключает AccountDeletionModule и адаптер ровно один раз', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChatModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === ChatFileAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverChatFiles, бакет по умолчанию прежний', () => {
    expect(DELETION_DISCOVERERS).toContain(discoverChatFiles);
    expect(chatFilesBucket()).toBe(BUCKET);
  });
});
