import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AccountDeletionRegistry } from '../../account-deletion/account-deletion.registry';
import type { DeletionJobRow } from '../../account-deletion/account-deletion.types';
import {
  ChatUploadAccountDeletionAdapter,
  CHAT_UPLOAD_RESOURCE_KEY,
  discoverChatUploads,
} from './chat-upload-account-deletion.adapter';

/**
 * chat-upload.purge против живого Postgres (Phase 2).
 *
 * Схема chat_uploads — дословно из РЕАЛЬНЫХ миграций
 * chat-uploads/migrations/001_chat_uploads.sql и 002 (thumb_key) (образец —
 * chat-file-account-deletion.pg.spec.ts, берущий боевые миграции
 * video_jobs/speech_clips), чтобы CHECK-ограничения (sha256, size_bytes) и
 * UNIQUE storage_key проверялись против боевых типов колонок. user_id —
 * минимальная фикстура (internal_id/state/deleted_at/deletion_id).
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const DELETION_ID = '11111111-1111-4111-8111-111111111111';
const BUCKET = 'linkeon-chat-uploads';
const SHA = 'a'.repeat(64);

maybe('chat-upload.purge против живого Postgres', () => {
  jest.setTimeout(30_000);

  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    // 001 + 002: с миграции 002 execute адаптера читает и thumb_key (миниатюры).
    for (const file of ['001_chat_uploads.sql', '002_chat_uploads_media_notes.sql']) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8'));
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
  });

  afterAll(async () => {
    await pool?.query('TRUNCATE chat_uploads, user_id CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE chat_uploads, user_id CASCADE');
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id)
       VALUES ('u-deleted','deleted',$1,$2)`,
      [DELETED_AT, DELETION_ID],
    );
  });

  const account = { userId: 'u-deleted', deletionId: DELETION_ID, deletedAt: DELETED_AT };
  const db = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]),
  };

  async function seedUpload(
    userId: string,
    key: string,
    name: string,
    thumbKey: string | null = null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO chat_uploads
         (user_id, session_id, original_name, mime, size_bytes, sha256, storage_key, thumb_key)
       VALUES ($1, $1 || '_12', $2, 'application/pdf', 10, $3, $4, $5)`,
      [userId, name, SHA, key, thumbKey],
    );
  }

  function makeAdapter() {
    const storage = {
      deleteConfirmed: jest.fn(
        async (_input: { bucket: string; key: string }): Promise<'deleted' | 'absent'> => 'deleted',
      ),
      delete: jest.fn(async (_input: { bucket: string; key: string }): Promise<void> => undefined),
    };
    const adapter = new ChatUploadAccountDeletionAdapter(storage as any, new AccountDeletionRegistry());
    const ctx = {
      db,
      assertCurrent: jest.fn(async (_job: DeletionJobRow): Promise<void> => undefined),
    };
    return { adapter, storage, ctx };
  }

  function job(userId = 'u-deleted'): DeletionJobRow {
    return {
      id: 'job-chat-upload-pg',
      deletionId: DELETION_ID,
      userId,
      resourceType: 'chat-upload.purge',
      resourceKey: CHAT_UPLOAD_RESOURCE_KEY,
      phase: 'purge',
      payload: {},
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date('2026-12-11T00:00:00Z'),
      leaseUntil: new Date('2026-12-11T01:00:00Z'),
      lastErrorKind: null,
    };
  }

  async function countUploads(userId: string): Promise<number> {
    const res = await pool.query(
      'SELECT count(*)::int AS n FROM chat_uploads WHERE user_id = $1',
      [userId],
    );
    return Number(res.rows[0].n);
  }

  it('discovery: строки есть — одна задача, нет — пустой план (настоящий SQL)', async () => {
    await seedUpload('u-deleted', 'k-1/файл.pdf', 'файл.pdf');

    const planned = await discoverChatUploads({ db, account, origin: 'explicit' });
    expect(planned.jobs).toHaveLength(1);
    expect(planned.jobs[0]).toEqual({
      resourceType: 'chat-upload.purge',
      resourceKey: CHAT_UPLOAD_RESOURCE_KEY,
      phase: 'purge',
      payload: {},
    });

    await pool.query('TRUNCATE chat_uploads');
    const empty = await discoverChatUploads({ db, account, origin: 'explicit' });
    expect(empty).toEqual({ jobs: [], skips: [] });
  });

  it('purge стирает только целевого пользователя: объекты через deleteConfirmed, строки удалены', async () => {
    await seedUpload('u-deleted', 'k-1/отчёт.pdf', 'отчёт.pdf');
    await seedUpload('u-deleted', 'k-2/photo (1).png', 'photo (1).png');
    await seedUpload('u-other', 'k-3/чужой.pdf', 'чужой.pdf');
    const { adapter, storage, ctx } = makeAdapter();

    await adapter.execute(job(), ctx);

    const deleted: Array<[string, string]> = storage.deleteConfirmed.mock.calls
      .map((call: [{ bucket: string; key: string }]): [string, string] => [call[0].bucket, call[0].key])
      .sort((a, b) => a[1].localeCompare(b[1]));
    // thumb_key NULL, но вычисляемые thumbs/<storage_key>.webp стираются тоже
    // (миниатюра могла лечь при неоднозначном сбое сохранения).
    const expected: Array<[string, string]> = [
      [BUCKET, 'k-1/отчёт.pdf'],
      [BUCKET, 'k-2/photo (1).png'],
      [BUCKET, 'thumbs/k-1/отчёт.pdf.webp'],
      [BUCKET, 'thumbs/k-2/photo (1).png.webp'],
    ];
    expect(deleted).toEqual(expected.sort((a, b) => a[1].localeCompare(b[1])));
    expect(await countUploads('u-deleted')).toBe(0);
    expect(await countUploads('u-other')).toBe(1);
  });

  it('повтор идемпотентен: строк нет — успех без deleteConfirmed', async () => {
    await seedUpload('u-deleted', 'k-1/файл.pdf', 'файл.pdf');
    const { adapter, storage, ctx } = makeAdapter();

    await adapter.execute(job(), ctx);
    expect(await countUploads('u-deleted')).toBe(0);

    storage.deleteConfirmed.mockClear();
    await expect(adapter.execute(job(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(await countUploads('u-deleted')).toBe(0);
  });

  it('сбой MinIO — строки сохраняются для retry (fail-closed)', async () => {
    await seedUpload('u-deleted', 'k-1/файл.pdf', 'файл.pdf');
    const { adapter, storage, ctx } = makeAdapter();
    storage.deleteConfirmed.mockRejectedValue({ response: { status: 503 } });

    await expect(adapter.execute(job(), ctx)).rejects.toMatchObject({ kind: 'external_5xx' });
    expect(await countUploads('u-deleted')).toBe(1);
  });

  it('реактивация между последним assertCurrent и DELETE — строки выжили (generation predicate)', async () => {
    await seedUpload('u-deleted', 'k-1/файл.pdf', 'файл.pdf');
    await seedUpload('u-deleted', 'k-2/фото.png', 'фото.png');
    const { adapter, storage, ctx } = makeAdapter();

    // Детерминированная симуляция гонки: реактивация коммитится в окне
    // ПОСЛЕ последнего assertCurrent (мок — no-op) и ровно ПЕРЕД финальным
    // DELETE. Обёртка над db при первом запросе 'DELETE FROM chat_uploads'
    // сначала возвращает аккаунт в живое поколение на той же БД, затем
    // делегирует запрос адаптера. Без generation-predicate внутри DELETE
    // отменённый job стирает строки живого аккаунта.
    let reactivated = false;
    const racingDb = {
      query: async (sql: string, params?: unknown[]) => {
        if (!reactivated && String(sql).startsWith('DELETE FROM chat_uploads')) {
          reactivated = true;
          await pool.query(
            `UPDATE user_id SET state='active', deletion_id=NULL WHERE internal_id='u-deleted'`,
          );
        }
        return db.query(sql, params);
      },
    };

    await adapter.execute(job(), { ...ctx, db: racingDb });

    expect(reactivated).toBe(true);
    // Объекты к этому моменту уже удалены — но строки-указатели живого
    // аккаунта стёрты НЕ были: счётчик поколения в DELETE их защитил.
    // 4 = два оригинала + две вычисляемые миниатюры (thumb_key NULL).
    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(4);
    expect(await countUploads('u-deleted')).toBe(2);
    const state = await pool.query(
      `SELECT state FROM user_id WHERE internal_id='u-deleted'`,
    );
    expect(state.rows[0].state).toBe('active');
  });

  it('миниатюры (thumb_key из 002) стираются вместе с оригиналами — настоящий SELECT', async () => {
    await seedUpload('u-deleted', 'k-1/фото.png', 'фото.png', 'thumbs/k-1/фото.png.webp');
    await seedUpload('u-deleted', 'k-2/отчёт.pdf', 'отчёт.pdf');
    await seedUpload('u-other', 'k-3/чужое.png', 'чужое.png', 'thumbs/k-3/чужое.png.webp');
    const { adapter, storage, ctx } = makeAdapter();
    // У строки без миниатюры вычисляемого объекта в бакете нет: absent —
    // подтверждённый успех и удалению строки не мешает.
    storage.deleteConfirmed.mockImplementation(
      async (input: { bucket: string; key: string }): Promise<'deleted' | 'absent'> =>
        input.key === 'thumbs/k-2/отчёт.pdf.webp' ? 'absent' : 'deleted',
    );

    await adapter.execute(job(), ctx);

    const deleted: Array<[string, string]> = storage.deleteConfirmed.mock.calls
      .map((call: [{ bucket: string; key: string }]): [string, string] => [call[0].bucket, call[0].key])
      .sort((a, b) => a[1].localeCompare(b[1]));
    const expected: Array<[string, string]> = [
      [BUCKET, 'k-1/фото.png'],
      [BUCKET, 'k-2/отчёт.pdf'],
      [BUCKET, 'thumbs/k-1/фото.png.webp'],
      [BUCKET, 'thumbs/k-2/отчёт.pdf.webp'],
    ];
    expect(deleted).toEqual(expected.sort((a, b) => a[1].localeCompare(b[1])));
    expect(await countUploads('u-deleted')).toBe(0);
    expect(await countUploads('u-other')).toBe(1);
  });
});
