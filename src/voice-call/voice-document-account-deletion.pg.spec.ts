import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AccountDeletionJobs } from '../account-deletion/account-deletion.jobs';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { deletionResourceHash } from '../account-deletion/account-deletion.safe';
import type { DeletionResourceType } from '../account-deletion/account-deletion.types';
import { VoiceAccountDeletionAdapter } from './voice-account-deletion.adapter';
import { DOCS_BUCKET } from './voice-call.types';
import { VoiceCallService } from './voice-call.service';
import { voiceDocumentFolder, voiceDocumentKey } from './voice-document-key';
import {
  VoiceDocumentAccountDeletionAdapter,
  discoverVoiceDocuments,
} from './voice-document-account-deletion';

/**
 * Task 15 — голосовые документы и строки звонков против живого Postgres.
 *
 * Discovery документов сканирует РЕАЛЬНЫЕ площадки DOC_PLACES (LIKE ANY по
 * солёной hashed-папке и legacy-папке userId), ref-check исполняет боевые
 * count(total)/count FILTER(own) запросы из CHAT_FILE_REF_PLACES, а порядок
 * «документы до строк» проверяется настоящим claimNext: правило каталога
 * voice.purge = sameResourceKey(voice.stop) + allOf(voice-document.purge)
 * живёт в DEPENDENCY_ELIGIBILITY_SQL, а не в раннере.
 *
 * Схема — из РЕАЛЬНЫХ миграций (voice-call, tasks, action-plans, video,
 * speech, talerid, account-deletion) в боевом порядке; custom_chat_history,
 * generated_images и user_id — inline-фикстуры той же формы, что в
 * chat-file-account-deletion.pg.spec.ts.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const DELETION_ID = '11111111-1111-4111-8111-111111111111';
const OLD_DELETION_ID = '55555555-5555-4555-8555-555555555555';

// Солёный хэш папки считается через relayFsKey: соль обязана быть выставлена
// ДО вычисления констант модуля.
const OLD_SALT = process.env.RELAY_FS_SALT;
process.env.RELAY_FS_SALT = 'voice-doc-deletion-pg-spec';
afterAll(() => {
  if (OLD_SALT === undefined) delete process.env.RELAY_FS_SALT;
  else process.env.RELAY_FS_SALT = OLD_SALT;
});

const DOC_ID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
const DOC_ID_2 = 'aaaaaaaa-1111-4222-8333-cccccccccccc';
const FOLDER = voiceDocumentFolder('u-deleted') as string;
const HASHED_KEY = voiceDocumentKey('u-deleted', DOC_ID) as string;
const LEGACY_KEY = `documents/u-deleted/${DOC_ID_2}.md`;
const docUrl = (key: string): string => `https://minio.test/${DOCS_BUCKET}/${key}`;
const HASHED_URL = docUrl(HASHED_KEY);
const LEGACY_URL = docUrl(LEGACY_KEY);
const TEXT_CANARY = 'ЛИЧНЫЙ-ТЕКСТ-ДОКУМЕНТА';

const MIGRATIONS: ReadonlyArray<readonly string[]> = [
  ['voice-call', 'migrations', '001_voice_calls.sql'],
  // 003 снимает UNIQUE room_name (два звонка в одной room-shared), 004 даёт
  // external_bot_id (fail-closed тест «external IDs целы»).
  ['meeting', 'migrations', '003_drop_room_name_unique.sql'],
  ['meeting', 'migrations', '004_meet_bot.sql'],
  ['tasks', 'migrations', '001_tasks.sql'],
  ['chat', 'action-plans', 'migrations', '001_action_plans.sql'],
  ['video', 'migrations', '001_video_jobs.sql'],
  ['speech', 'migrations', '001_speech_clips.sql'],
  ['talerid', 'migrations', '001_talerid.sql'],
];

async function seedCallJob(pool: Pool, callId: string, question: string, answer: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO voice_call_jobs (id,call_id,specialist_agent_id,question,status,answer)
     VALUES (gen_random_uuid(),$1,12,$2,'done',$3)`,
    [callId, question, answer],
  );
}

async function seedTask(pool: Pool, userId: string, summary: string): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (user_id,title,summary,status) VALUES ($1,'t',$2,'active')`,
    [userId, summary],
  );
}

async function createSchema(pool: Pool): Promise<void> {
  // Inline-фикстуры той же формы, что в chat-file-account-deletion.pg.spec.ts.
  await pool.query(`CREATE TABLE IF NOT EXISTS custom_chat_history (
    id serial PRIMARY KEY,
    session_id text NOT NULL,
    sender_type varchar(10) NOT NULL CHECK (sender_type IN ('ai', 'human')),
    agent integer,
    content text NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    message_type varchar(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image')),
    tokens_used integer DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS generated_images (
    id serial PRIMARY KEY,
    user_id text NOT NULL,
    prompt text NOT NULL DEFAULT '',
    image_url text NOT NULL,
    tokens_spent integer DEFAULT 5000,
    created_at timestamptz DEFAULT now()
  )`);
  for (const rel of MIGRATIONS) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8'));
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
    internal_id text PRIMARY KEY,
    state text,
    deleted_at timestamptz,
    deletion_id uuid
  )`);
}

const TRUNCATED = `custom_chat_history, generated_images, video_jobs, speech_clips,
  task_events, tasks, action_plans, voice_call_jobs, voice_calls,
  talerid_connections, user_id`;

const account = { userId: 'u-deleted', deletionId: DELETION_ID, deletedAt: DELETED_AT };

async function seedAccount(
  pool: Pool,
  userId: string,
  deletionId: string | null,
  state = 'deleted',
): Promise<void> {
  await pool.query(
    `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (internal_id) DO UPDATE
       SET state=$2, deleted_at=$3, deletion_id=$4`,
    [userId, state, state === 'deleted' ? DELETED_AT : null, deletionId],
  );
}

async function seedCall(
  pool: Pool,
  o: { userId: string; roomName: string; status?: string; transcript?: unknown; summary?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO voice_calls (id,user_id,agent_id,room_name,status,transcript,summary)
     VALUES ($1,$2,12,$3,$4,$5,$6)`,
    [id, o.userId, o.roomName, o.status ?? 'completed',
      o.transcript !== undefined ? JSON.stringify(o.transcript) : null, o.summary ?? null],
  );
  return id;
}

maybe('discoverVoiceDocuments против живого Postgres', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  const db = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]),
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await createSchema(pool);
  });

  afterAll(async () => {
    await pool?.query(`TRUNCATE ${TRUNCATED} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${TRUNCATED} CASCADE`);
    await seedAccount(pool, 'u-deleted', DELETION_ID);
  });

  it('hashed-документ находится во всех площадках DOC_PLACES, дедуп по docId', async () => {
    const callId = await seedCall(pool, {
      userId: 'u-deleted',
      roomName: 'voice_doc-1',
      transcript: [{ role: 'user', text: `документ ${HASHED_URL} ${TEXT_CANARY}` }],
      summary: `итоги со ссылкой ${HASHED_URL}`,
    });
    await seedCallJob(pool, callId, `вопрос про ${HASHED_URL}`, 'ответ');
    await pool.query(
      `INSERT INTO custom_chat_history (session_id,sender_type,agent,content,message_type)
       VALUES ('u-deleted_a','ai',12,$1,'text')`,
      [`[Открыть документ полностью](${HASHED_URL})`],
    );
    await seedTask(pool, 'u-deleted', `задача со ссылкой ${HASHED_URL}`);

    const plan = await discoverVoiceDocuments({ db, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]).toEqual({
      resourceType: 'voice-document.purge',
      resourceKey: deletionResourceHash(DOCS_BUCKET, HASHED_KEY),
      phase: 'purge',
      payload: { docId: DOC_ID, keyKind: 'hashed' },
    });
    // CANARY: payload не содержит ни userId, ни URL, ни текстов.
    const payloadJson = JSON.stringify(plan.jobs[0].payload);
    expect(payloadJson).not.toContain('u-deleted');
    expect(payloadJson).not.toContain('http');
    expect(payloadJson).not.toContain(TEXT_CANARY);
    expect(payloadJson).not.toContain(FOLDER);
  });

  it('legacy-документ (папка = userId) — отдельный job keyKind legacy', async () => {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id,sender_type,agent,content,message_type)
       VALUES ('u-deleted_a','ai',12,$1,'text')`,
      [`старый документ ${LEGACY_URL}`],
    );

    const plan = await discoverVoiceDocuments({ db, account, origin: 'explicit' });

    const legacyJobs = plan.jobs.filter((j) => j.payload?.keyKind === 'legacy');
    expect(legacyJobs).toEqual([{
      resourceType: 'voice-document.purge',
      resourceKey: deletionResourceHash(DOCS_BUCKET, LEGACY_KEY),
      phase: 'purge',
      payload: { docId: DOC_ID_2, keyKind: 'legacy' },
    }]);
  });

  it('чужая ссылка на МОЙ hashed-документ тоже планируется (судьбу решит ref-check)', async () => {
    await seedTask(pool, 'u-other', `чужая задача со ссылкой ${HASHED_URL}`);

    const plan = await discoverVoiceDocuments({ db, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].payload).toEqual({ docId: DOC_ID, keyKind: 'hashed' });
  });

  it('чужой hashed-документ (папка другого пользователя) в план не попадает', async () => {
    const otherFolder = voiceDocumentFolder('u-other') as string;
    const otherKey = `documents/${otherFolder}/${DOC_ID}.md`;
    await pool.query(
      `INSERT INTO custom_chat_history (session_id,sender_type,agent,content,message_type)
       VALUES ('u-deleted_a','ai',12,$1,'text')`,
      [`ссылка на чужой документ ${docUrl(otherKey)}`],
    );

    const plan = await discoverVoiceDocuments({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([]);
  });

  it('generation predicate: чужой deletionId или живой аккаунт — план пустой', async () => {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id,sender_type,agent,content,message_type)
       VALUES ('u-deleted_a','ai',12,$1,'text')`,
      [`документ ${HASHED_URL}`],
    );

    const stale = await discoverVoiceDocuments({
      db,
      account: { ...account, deletionId: OLD_DELETION_ID },
      origin: 'explicit',
    });
    expect(stale.jobs).toEqual([]);
    expect(stale.skips).toEqual([]);

    await seedAccount(pool, 'u-deleted', null, 'active');
    const reactivated = await discoverVoiceDocuments({ db, account, origin: 'explicit' });
    expect(reactivated.jobs).toEqual([]);
  });

  it('TalerID-заметки: один агрегированный skip, внешних вызовов нет', async () => {
    await seedCall(pool, { userId: 'u-deleted', roomName: 'voice_note-1' });

    // Без подключения TalerID — skip'а нет.
    const withoutConnection = await discoverVoiceDocuments({ db, account, origin: 'explicit' });
    expect(withoutConnection.skips).toEqual([]);

    await pool.query(
      `INSERT INTO talerid_connections (user_id,talerid_user_id,refresh_token_enc,access_token_enc,status)
       VALUES ('u-deleted','t-1','enc','enc','active')`,
    );
    const withConnection = await discoverVoiceDocuments({ db, account, origin: 'explicit' });
    expect(withConnection.skips).toEqual([{
      resourceType: 'integration.talerid.stop',
      reason: 'external_note_id_unavailable',
    }]);

    // Подключение есть, но звонков не было — заметок создавать было негде.
    await pool.query('TRUNCATE voice_calls CASCADE');
    const withoutCalls = await discoverVoiceDocuments({ db, account, origin: 'explicit' });
    expect(withoutCalls.skips).toEqual([]);
  });
});

maybe('voice-document.purge и voice.purge против живого Postgres', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  const db = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]),
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await createSchema(pool);
    await pool.query(fs.readFileSync(
      path.join(__dirname, '..', 'account-deletion', 'migrations', '001_account_deletion.sql'),
      'utf8',
    ));
  });

  afterAll(async () => {
    await pool?.query(`TRUNCATE ${TRUNCATED}, account_deletion_jobs CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${TRUNCATED}, account_deletion_jobs CASCADE`);
    await seedAccount(pool, 'u-deleted', DELETION_ID);
  });

  function makeDocAdapter() {
    const storage = {
      deleteConfirmed: jest.fn(async (): Promise<'deleted' | 'absent'> => 'deleted'),
      delete: jest.fn(async () => undefined),
    };
    const adapter = new VoiceDocumentAccountDeletionAdapter(
      storage as any,
      new AccountDeletionRegistry(),
    );
    const ctx = { db, assertCurrent: jest.fn(async () => undefined) };
    return { adapter, storage, ctx };
  }

  function docJobRow(payload: Record<string, unknown>) {
    return {
      id: 'job-doc-1',
      deletionId: DELETION_ID,
      userId: account.userId,
      resourceType: 'voice-document.purge' as const,
      resourceKey: `doc-${payload.docId}`,
      phase: 'purge' as const,
      payload,
      status: 'running' as const,
      attempts: 1,
      nextAttemptAt: new Date(),
      leaseUntil: new Date(Date.now() + 300_000),
      lastErrorKind: null,
    };
  }

  it('ref-check на боевом SQL: чужая ссылка сохраняет объект, своя — не блокирует', async () => {
    const { adapter, storage, ctx } = makeDocAdapter();
    await seedTask(pool, 'u-other', `чужая ссылка ${HASHED_URL}`);

    await adapter.execute(docJobRow({ docId: DOC_ID, keyKind: 'hashed' }), ctx);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();

    // Убираем чужую ссылку, кладём свою (transcript своего звонка): объект
    // удаляется, а своя строка живёт до voice.purge — без retry-deadlock'а.
    await pool.query('TRUNCATE tasks CASCADE');
    const callId = await seedCall(pool, {
      userId: 'u-deleted',
      roomName: 'voice_doc-2',
      transcript: [{ role: 'user', text: HASHED_URL }],
    });
    await adapter.execute(docJobRow({ docId: DOC_ID, keyKind: 'hashed' }), ctx);
    expect(storage.deleteConfirmed).toHaveBeenCalledWith({
      bucket: DOCS_BUCKET,
      key: HASHED_KEY,
    });
    const call = await pool.query('SELECT id FROM voice_calls WHERE id=$1', [callId]);
    expect(call.rowCount).toBe(1);
  });

  it('legacy-ключ строится из job.userId в execute, не из payload', async () => {
    const { adapter, storage, ctx } = makeDocAdapter();

    await adapter.execute(docJobRow({ docId: DOC_ID_2, keyKind: 'legacy' }), ctx);

    expect(storage.deleteConfirmed).toHaveBeenCalledWith({
      bucket: DOCS_BUCKET,
      key: LEGACY_KEY,
    });
  });

  it('MinIO 503 — retry external_5xx, строки звонка и external IDs целы', async () => {
    const { adapter, storage, ctx } = makeDocAdapter();
    const callId = await seedCall(pool, {
      userId: 'u-deleted',
      roomName: 'voice_doc-3',
      transcript: [{ role: 'user', text: HASHED_URL }],
    });
    await pool.query(
      `UPDATE voice_calls SET status='active', external_bot_id='bot-1' WHERE id=$1`,
      [callId],
    );
    await seedCallJob(pool, callId, 'q', 'a');
    storage.deleteConfirmed.mockRejectedValue({ response: { status: 503 } });

    await expect(
      adapter.execute(docJobRow({ docId: DOC_ID, keyKind: 'hashed' }), ctx),
    ).rejects.toMatchObject({ kind: 'external_5xx' });

    const call = await pool.query(
      'SELECT external_bot_id FROM voice_calls WHERE id=$1', [callId],
    );
    expect(call.rowCount).toBe(1);
    expect(call.rows[0].external_bot_id).toBe('bot-1');
    const jobs = await pool.query(
      'SELECT id FROM voice_call_jobs WHERE call_id=$1', [callId],
    );
    expect(jobs.rowCount).toBe(1);
  });

  it('voice.purge удаляет строку, voice_call_jobs уходит FK-каскадом, чужой звонок цел', async () => {
    const voice = new VoiceCallService(db as any, {} as any, {} as any);
    const adapter = new VoiceAccountDeletionAdapter(
      voice,
      undefined,
      new AccountDeletionRegistry(),
    );
    const ctx = { db, assertCurrent: jest.fn(async () => undefined) };

    const callId = await seedCall(pool, {
      userId: 'u-deleted',
      roomName: 'room-shared',
      transcript: [{ role: 'user', text: HASHED_URL }],
    });
    await seedCallJob(pool, callId, 'q', 'a');
    const foreignCallId = await seedCall(pool, {
      userId: 'u-other',
      roomName: 'room-shared',
      transcript: [{ role: 'user', text: HASHED_URL }],
    });

    await adapter.execute({
      id: 'job-purge-1',
      deletionId: DELETION_ID,
      userId: account.userId,
      resourceType: 'voice.purge',
      resourceKey: callId,
      phase: 'purge',
      payload: { callId },
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(),
      leaseUntil: new Date(Date.now() + 300_000),
      lastErrorKind: null,
    }, ctx);

    const own = await pool.query('SELECT id FROM voice_calls WHERE id=$1', [callId]);
    expect(own.rowCount).toBe(0);
    const ownJobs = await pool.query(
      'SELECT id FROM voice_call_jobs WHERE call_id=$1', [callId],
    );
    expect(ownJobs.rowCount).toBe(0);
    // Чужой звонок и его transcript сохраняются (shared room не тронута).
    const foreign = await pool.query(
      'SELECT transcript FROM voice_calls WHERE id=$1', [foreignCallId],
    );
    expect(foreign.rowCount).toBe(1);
    expect(JSON.stringify(foreign.rows[0].transcript)).toContain('documents');

    // Идемпотентный повтор.
    await expect(adapter.execute({
      id: 'job-purge-1',
      deletionId: DELETION_ID,
      userId: account.userId,
      resourceType: 'voice.purge',
      resourceKey: callId,
      phase: 'purge',
      payload: { callId },
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(),
      leaseUntil: new Date(Date.now() + 300_000),
      lastErrorKind: null,
    }, ctx)).resolves.toBeUndefined();
  });

  it('voice.purge ждёт document jobs: claimNext не отдаёт purge, пока doc не done', async () => {
    const jobs = new AccountDeletionJobs(db);
    const callId = crypto.randomUUID();
    const docKey = deletionResourceHash(DOCS_BUCKET, HASHED_KEY);

    async function insertJob(
      resourceType: DeletionResourceType,
      resourceKey: string,
      status: string,
      payload: Record<string, unknown> = {},
    ): Promise<string> {
      const phase = resourceType.endsWith('.stop') ? 'immediate' : 'purge';
      const res = await pool.query(
        `INSERT INTO account_deletion_jobs
          (deletion_id,user_id,resource_type,resource_key,phase,payload_jsonb,
           status,attempts,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,0,now()-interval '1 minute')
         RETURNING id`,
        [DELETION_ID, account.userId, resourceType, resourceKey, phase,
          JSON.stringify(payload), status],
      );
      return res.rows[0].id;
    }

    const stopId = await insertJob('voice.stop', callId, 'done', { callId });
    const docId = await insertJob('voice-document.purge', docKey, 'pending',
      { docId: DOC_ID, keyKind: 'hashed' });
    await insertJob('voice.purge', callId, 'pending', { callId });

    // Doc ещё pending: claimNext обязан отдать doc-задачу, а не voice.purge
    // (правило каталога allOf:['voice-document.purge'] + sameResourceKey
    // voice.stop исполняет DEPENDENCY_ELIGIBILITY_SQL в claimNext).
    const first = await jobs.claimNext(DELETION_ID);
    expect(first?.id).toBe(docId);
    expect(first?.resourceType).not.toBe('voice.purge');
    await pool.query(`UPDATE account_deletion_jobs SET status='done' WHERE id=$1`, [docId]);

    // Все зависимости закрыты (stop done, doc done) — purge становится доступен.
    const second = await jobs.claimNext(DELETION_ID);
    expect(second?.resourceType).toBe('voice.purge');
    expect(second?.resourceKey).toBe(callId);

    // Откат doc в pending снова блокирует purge.
    await pool.query(
      `UPDATE account_deletion_jobs SET status='pending', lease_until=NULL WHERE id=$1`,
      [docId],
    );
    await pool.query(
      `UPDATE account_deletion_jobs SET status='pending', lease_until=NULL WHERE id=$1`,
      [second!.id],
    );
    const third = await jobs.claimNext(DELETION_ID);
    expect(third?.id).toBe(docId);
    expect(stopId).toBeTruthy();
  });
});
