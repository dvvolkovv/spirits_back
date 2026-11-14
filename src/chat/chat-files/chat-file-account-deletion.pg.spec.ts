import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AccountDeletionRegistry } from '../../account-deletion/account-deletion.registry';
import { deletionResourceHash } from '../../account-deletion/account-deletion.safe';
import type { DeletionJobRow } from '../../account-deletion/account-deletion.types';
import {
  ChatFileAccountDeletionAdapter,
  discoverChatFiles,
} from './chat-file-account-deletion.adapter';

/**
 * Discovery chat-file.purge против живого Postgres (Task 11).
 *
 * Фейковая БД unit-спека повторяет SQL по памяти; здесь keyset-пагинация
 * (id > $2 ORDER BY id LIMIT), LIKE '<userId>\_%' ESCAPE и generation
 * predicate исполняются по-настоящему. Схема custom_chat_history — как на
 * проде (guest-claim.pg.spec.ts, \d 30.10.2026); video_jobs и speech_clips —
 * из РЕАЛЬНЫХ миграций, чтобы ownership-запросы маркеров проверялись против
 * боевых типов колонок.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const DELETION_ID = '11111111-1111-4111-8111-111111111111';
const OLD_DELETION_ID = '55555555-5555-4555-8555-555555555555';

const ENV = {
  publicBaseUrl: 'https://minio.test',
  agentUrl: 'https://r.test',
  backendUrl: 'https://api.test',
};
const BUCKET = 'linkeon-chat-files';
const TEXT_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';

/** Прод-форма payload.key: base64url от сырого ключа (см. адаптер). */
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function minioUrl(id: string, name: string): string {
  return `${ENV.publicBaseUrl}/${BUCKET}/${id}/${name.split('/').map(encodeURIComponent).join('/')}`;
}

maybe('discoverChatFiles против живого Postgres', () => {
  jest.setTimeout(30_000);

  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await pool.query(`CREATE TABLE IF NOT EXISTS custom_chat_history (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      sender_type varchar(10) NOT NULL CHECK (sender_type IN ('ai', 'human')),
      agent integer,
      content text NOT NULL,
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      message_type varchar(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image')),
      tokens_used integer DEFAULT 0)`);
    for (const rel of [
      ['video', 'migrations', '001_video_jobs.sql'],
      ['speech', 'migrations', '001_speech_clips.sql'],
    ]) {
      await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', ...rel), 'utf8'));
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
  });

  afterAll(async () => {
    await pool?.query('TRUNCATE custom_chat_history, video_jobs, speech_clips, user_id CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE custom_chat_history, video_jobs, speech_clips, user_id CASCADE');
  });

  const account = { userId: 'u-deleted', deletionId: DELETION_ID, deletedAt: DELETED_AT };
  const db = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]),
  };

  async function seedAccount(
    userId: string,
    deletionIdValue: string | null,
    state = 'deleted',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id) VALUES ($1,$2,$3,$4)`,
      [userId, state, state === 'deleted' ? DELETED_AT : null, deletionIdValue],
    );
  }

  async function seedHistory(rows: Array<{
    id: number;
    session_id: string;
    sender_type: 'human' | 'ai';
    content: string;
  }>): Promise<void> {
    for (const r of rows) {
      await pool.query(
        `INSERT INTO custom_chat_history (id,session_id,sender_type,agent,content,message_type)
         VALUES ($1,$2,$3,12,$4,'text')`,
        [r.id, r.session_id, r.sender_type, r.content],
      );
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('custom_chat_history','id'), (SELECT max(id) FROM custom_chat_history))`);
  }

  it('читает human+ai всеми страницами и сохраняет только MinIO locator', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const videoJobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const chatUrl = minioUrl('22222222-2222-4222-8222-222222222222', 'отчёт.pdf');
    await seedHistory([
      { id: 1, session_id: 'u-deleted_a', sender_type: 'human', content: `[VIDEO_JOB:${videoJobId}]` },
      { id: 2, session_id: 'u-deleted_a', sender_type: 'ai', content: `[Файл](${chatUrl}) ${TEXT_CANARY}` },
      { id: 3, session_id: 'u-deleted_a', sender_type: 'ai', content: '[external](https://example.com/x.mp4)' },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV, pageSize: 1 });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].resourceType).toBe('chat-file.purge');
    expect(plan.jobs[0].resourceKey).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.jobs[0].resourceKey).toBe(
      deletionResourceHash(BUCKET, '22222222-2222-4222-8222-222222222222/отчёт.pdf'),
    );
    expect(plan.jobs[0].payload).toEqual({
      bucket: BUCKET,
      key: b64('22222222-2222-4222-8222-222222222222/отчёт.pdf'),
    });
    const payloadJson = JSON.stringify(plan.jobs[0].payload);
    expect(payloadJson).not.toContain(TEXT_CANARY);
    expect(payloadJson).not.toContain('u-deleted');
    expect(payloadJson).not.toContain('minio.test');
    // Чужой marker без строки video_jobs — skip, не job.
    expect(plan.skips).toEqual([
      { resourceType: 'chat-file.purge', reason: 'owner_unverifiable' },
    ]);
  });

  it('keyset: pageSize=1 собирает все файлы из многих страниц', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const rows = [];
    for (let i = 1; i <= 5; i += 1) {
      rows.push({
        id: i,
        session_id: i % 2 === 0 ? 'u-deleted_a' : 'u-deleted_custom:x',
        sender_type: (i % 2 === 0 ? 'ai' : 'human') as 'ai' | 'human',
        content: `[Файл](${minioUrl(`id-${i}`, `f${i}.pdf`)})`,
      });
    }
    await seedHistory(rows);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV, pageSize: 1 });

    expect(plan.jobs).toHaveLength(5);
    const keys = new Set(plan.jobs.map((j) => (j.payload as any).key));
    expect(keys.size).toBe(5);
  });

  it('LIKE escape: сессия u-deletedX_a и u-deleted2_a не читаются', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    await seedHistory([
      { id: 1, session_id: 'u-deletedX_a', sender_type: 'ai', content: `[Файл](${minioUrl('k1', 'a.pdf')})` },
      { id: 2, session_id: 'u-deleted2_a', sender_type: 'ai', content: `[Файл](${minioUrl('k2', 'b.pdf')})` },
      { id: 3, session_id: 'u-deletedXa', sender_type: 'ai', content: `[Файл](${minioUrl('k3', 'c.pdf')})` },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });

    expect(plan.jobs).toEqual([]);
  });

  it('generation predicate: чужой deletionId или реактивация — план пустой', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    await seedHistory([
      { id: 1, session_id: 'u-deleted_a', sender_type: 'ai', content: `[Файл](${minioUrl('k1', 'a.pdf')})` },
    ]);

    const stale = await discoverChatFiles({
      db,
      account: { ...account, deletionId: OLD_DELETION_ID },
      origin: 'explicit',
      env: ENV,
    });
    expect(stale.jobs).toEqual([]);

    await pool.query(`UPDATE user_id SET state='active', deletion_id=NULL, deleted_at=NULL WHERE internal_id='u-deleted'`);
    const reactivated = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });
    expect(reactivated.jobs).toEqual([]);
  });

  it('свой video_job и speech_clip — без chat-file job (объекты чистят Task 12/13)', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const videoJobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const clipId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await pool.query(
      `INSERT INTO video_jobs (id,user_id,mode,model,quality,duration_sec,tokens_spent,status)
       VALUES ($1,'u-deleted','t2v','veo-3.1','std',5,0,'done')`,
      [videoJobId],
    );
    await pool.query(
      `INSERT INTO speech_clips (id,user_id,cache_key,url,duration_sec,chars,provider,voice,lang)
       VALUES ($1,'u-deleted','ck','https://minio.test/linkeon-speech/x.mp3',1,10,'p','v','ru')`,
      [clipId],
    );
    await seedHistory([
      { id: 1, session_id: 'u-deleted_a', sender_type: 'ai', content: `[VIDEO_JOB:${videoJobId}] {{audio:id=${clipId}}}` },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });

    expect(plan.jobs).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it('чужой video_job с тем же id — skip owner_unverifiable, не job', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const videoJobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await pool.query(
      `INSERT INTO video_jobs (id,user_id,mode,model,quality,duration_sec,tokens_spent,status)
       VALUES ($1,'u-other','t2v','veo-3.1','std',5,0,'done')`,
      [videoJobId],
    );
    await seedHistory([
      { id: 1, session_id: 'u-deleted_a', sender_type: 'ai', content: `[VIDEO_JOB:${videoJobId}]` },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });

    expect(plan.jobs).toEqual([]);
    expect(plan.skips).toEqual([
      { resourceType: 'chat-file.purge', reason: 'owner_unverifiable' },
    ]);
  });

  it('URL с query/якорем и закодированным именем — ключ раскодируется, locator стабильный', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const url = `${minioUrl('k-1', 'Договор (1).docx')}?v=2#frag`;
    await seedHistory([
      { id: 1, session_id: 'u-deleted_a', sender_type: 'ai', content: `[Договор 1) x](${url})` },
    ]);

    const plan = await discoverChatFiles({ db, account, origin: 'explicit', env: ENV });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].payload).toEqual({ bucket: BUCKET, key: b64('k-1/Договор (1).docx') });
  });
});

maybe('purge chat-file.purge против живого Postgres (ref-check SQL)', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  const FILE_KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/фото webp.png';
  const FILE_URL = minioUrl('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'фото webp.png');

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await pool.query(`CREATE TABLE IF NOT EXISTS custom_chat_history (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      sender_type varchar(10) NOT NULL CHECK (sender_type IN ('ai', 'human')),
      agent integer,
      content text NOT NULL,
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      message_type varchar(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image')),
      tokens_used integer DEFAULT 0)`);
    for (const rel of [
      ['video', 'migrations', '001_video_jobs.sql'],
      ['speech', 'migrations', '001_speech_clips.sql'],
      ['tasks', 'migrations', '001_tasks.sql'],
      ['chat', 'action-plans', 'migrations', '001_action_plans.sql'],
      ['voice-call', 'migrations', '001_voice_calls.sql'],
    ]) {
      await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', ...rel), 'utf8'));
    }
    // Форма фикстуры, как в product/voice pg-спеках: IF NOT EXISTS, минимум колонок.
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS generated_images (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      prompt text NOT NULL DEFAULT '',
      image_url text NOT NULL,
      tokens_spent integer DEFAULT 5000,
      created_at timestamptz DEFAULT now()
    )`);
  });

  afterAll(async () => {
    await pool?.query(`TRUNCATE custom_chat_history, video_jobs, speech_clips, task_events, tasks,
      action_plans, voice_call_jobs, voice_calls, generated_images, user_id CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE custom_chat_history, video_jobs, speech_clips, task_events, tasks,
      action_plans, voice_call_jobs, voice_calls, generated_images, user_id CASCADE`);
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id)
       VALUES ('u-deleted','deleted',$1,$2)`,
      [DELETED_AT, DELETION_ID],
    );
  });

  function makeAdapter() {
    const storage = {
      deleteConfirmed: jest.fn(async () => 'deleted' as 'deleted' | 'absent'),
      delete: jest.fn(async () => undefined),
    };
    const adapter = new ChatFileAccountDeletionAdapter(storage as any, new AccountDeletionRegistry());
    const ctx = {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      assertCurrent: jest.fn(async () => undefined),
    };
    return { adapter, storage, ctx };
  }

  function job(): DeletionJobRow {
    return {
      id: 'job-chat-file-pg',
      deletionId: DELETION_ID,
      userId: 'u-deleted',
      resourceType: 'chat-file.purge',
      resourceKey: deletionResourceHash(BUCKET, FILE_KEY),
      phase: 'purge',
      payload: { bucket: BUCKET, key: b64(FILE_KEY) },
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date('2026-12-11T00:00:00Z'),
      leaseUntil: new Date('2026-12-11T01:00:00Z'),
      lastErrorKind: null,
    };
  }

  it('ссылок нигде нет: объект и миниатюра удаляются (настоящий ref-check SQL)', async () => {
    const { adapter, storage, ctx } = makeAdapter();

    await adapter.execute(job(), ctx);

    expect(storage.deleteConfirmed).toHaveBeenCalledWith({ bucket: BUCKET, key: FILE_KEY });
    expect(storage.deleteConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'linkeon-assets' }),
    );
  });

  it('ссылка в чужой истории/задаче/итоге звонка — объект сохраняется', async () => {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id,sender_type,content) VALUES ('u-other_a','ai',$1)`,
      [`[Файл](${FILE_URL})`],
    );
    const { adapter, storage, ctx } = makeAdapter();

    await expect(adapter.execute(job(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();

    // Чужая задача с той же ссылкой — тот же исход.
    await pool.query(`TRUNCATE custom_chat_history`);
    await pool.query(
      `INSERT INTO tasks (user_id,title,summary) VALUES ('u-other','t',$1)`,
      [`см. ${FILE_URL}`],
    );
    await expect(adapter.execute(job(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('ссылка в jsonb (action_plans.items, voice_calls.transcript) тоже находится', async () => {
    await pool.query(
      `INSERT INTO action_plans (user_id,session_id,assistant_id,title,items)
       VALUES ('u-other','s','12','t',$1::jsonb)`,
      [JSON.stringify([{ link: FILE_URL }])],
    );
    const { adapter, storage, ctx } = makeAdapter();

    await expect(adapter.execute(job(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('ссылка в СОБСТВЕННОЙ строке удалённого аккаунта — retry kind db', async () => {
    await pool.query(
      `INSERT INTO generated_images (user_id,prompt,image_url) VALUES ('u-deleted','p',$1)`,
      [FILE_URL],
    );
    const { adapter, storage, ctx } = makeAdapter();

    await expect(adapter.execute(job(), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('M7: ссылка в чужом voice_call_jobs (LEFT JOIN voice_calls) — объект сохраняется', async () => {
    const callId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await pool.query(
      `INSERT INTO voice_calls (id,user_id,agent_id,room_name,status)
       VALUES ($1,'u-other',12,'room-m7-1','ended')`,
      [callId],
    );
    await pool.query(
      `INSERT INTO voice_call_jobs (id,call_id,specialist_agent_id,question,status,answer)
       VALUES ('dddddddd-dddd-4ddd-8ddd-ddddddddde',$1,13,$2,'done',$3)`,
      [callId, `вопрос со ссылкой ${FILE_URL}`, 'ответ'],
    );
    const { adapter, storage, ctx } = makeAdapter();

    await expect(adapter.execute(job(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('M7: ссылка в чужом task_events (LEFT JOIN tasks) — объект сохраняется', async () => {
    const taskId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await pool.query(
      `INSERT INTO tasks (id,user_id,title,summary) VALUES ($1,'u-other','t','')`,
      [taskId],
    );
    await pool.query(
      `INSERT INTO task_events (task_id,kind,content) VALUES ($1,'note',$2)`,
      [taskId, `заметка со ссылкой ${FILE_URL}`],
    );
    const { adapter, storage, ctx } = makeAdapter();

    await expect(adapter.execute(job(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('M7: каждая из 4 url-колонок чужого video_jobs сохраняет объект', async () => {
    for (const col of ['video_url', 'thumbnail_url', 'audio_url', 'source_image_url']) {
      await pool.query(`TRUNCATE video_jobs`);
      await pool.query(
        `INSERT INTO video_jobs (id,user_id,mode,model,quality,duration_sec,tokens_spent,status,${col})
         VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff','u-other','t2v','veo-3.1','std',5,0,'done',$1)`,
        [FILE_URL],
      );
      const { adapter, storage, ctx } = makeAdapter();

      await expect(adapter.execute(job(), ctx)).resolves.toBeUndefined();
      expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    }
  });
});
