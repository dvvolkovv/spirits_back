import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import type { DeletionJobSpec } from '../account-deletion/account-deletion.types';
import { discoverVoiceDeletion } from './voice-account-deletion.adapter';
import { VoiceCallService } from './voice-call.service';
import { HOST_AGENT_ID, type CompletePayload } from './voice-call.types';

/**
 * Discovery voice.stop/voice.purge против живого Postgres (Task 10, follow-up
 * ревью; Task 15 добавил purge-задачи на строки звонков).
 *
 * Фейковая БД unit-спека повторяет SQL по памяти, и самый сложный
 * discoverer-запрос проекта (два коррелированных EXISTS, LIKE 'room\_%' с
 * экранированием, substr(room_name, 6)) ни разу не исполнялся по-настоящему.
 * Здесь — исполняется: схема собирается из РЕАЛЬНЫХ миграций voice/meeting в
 * боевом порядке, поэтому типы колонок (UUID id, TEXT user_id) и ограничения
 * те же, что на проде.
 */

// Полный тип задачи (DeletionJobSpec), а не узкий { resourceType }: спек
// проверяет payload/resourceKey/phase отфильтрованных задач, и broad tsc
// (tsconfig.json включает спеки) обязан это видеть.
const stopsOf = (jobs: readonly DeletionJobSpec[]) =>
  jobs.filter((j) => j.resourceType === 'voice.stop');
const purgesOf = (jobs: readonly DeletionJobSpec[]) =>
  jobs.filter((j) => j.resourceType === 'voice.purge');

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const DELETION_ID = '11111111-1111-4111-8111-111111111111';
const OLD_DELETION_ID = '55555555-5555-4555-8555-555555555555';
const ZOOM_URL_CANARY = 'https://zoom.us/j/123456?zak=CANARY-ZOOM-TOKEN';

maybe('discoverVoiceDeletion против живого Postgres', () => {
  jest.setTimeout(30_000);

  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    // Реальные миграции в боевом порядке. Пропущены только те, что не нужны
    // discovery: 002_agent_realtime_voice (колонка таблицы agents),
    // 003_call_tokens/003_voice_call_origin/004_end_reason/005_participants
    // (колонки, которые discovery не читает).
    for (const rel of [
      ['voice-call', 'migrations', '001_voice_calls.sql'],
      ['meeting', 'migrations', '001_meeting_rooms.sql'],
      ['meeting', 'migrations', '003_drop_room_name_unique.sql'],
      ['meeting', 'migrations', '004_meet_bot.sql'],
      ['meeting', 'migrations', '005_zoom_url.sql'],
    ]) {
      await pool.query(fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8'));
    }
    // Та же форма фикстуры user_id, что в product-account-deletion.pg.spec.ts:
    // IF NOT EXISTS, nullable state — порядок suite'ов при общем
    // PROVISIONING_PG_URL не влияет на результат.
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
  });

  afterAll(async () => {
    await pool?.query('TRUNCATE voice_calls, meeting_rooms, user_id CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE voice_calls, meeting_rooms, user_id CASCADE');
  });

  const account = { userId: 'u-deleted', deletionId: DELETION_ID, deletedAt: DELETED_AT };

  const db = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]),
  };

  async function seedAccount(
    userId: string,
    deletionId: string | null,
    state = 'deleted',
    deletedAt: Date | null = DELETED_AT,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id) VALUES ($1,$2,$3,$4)`,
      [userId, state, deletedAt, deletionId],
    );
  }

  async function seedCall(o: {
    userId: string;
    roomName: string;
    status?: string;
    botId?: string | null;
    externalUrl?: string | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO voice_calls (id,user_id,agent_id,room_name,status,external_bot_id,external_url)
       VALUES ($1,$2,12,$3,$4,$5,$6)`,
      [id, o.userId, o.roomName, o.status ?? 'active', o.botId ?? null, o.externalUrl ?? null],
    );
    return id;
  }

  async function seedRoom(code: string, owner: string, closed: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO meeting_rooms (code,owner_user_id,closed_at) VALUES ($1,$2,$3)`,
      [code, owner, closed ? DELETED_AT : null],
    );
  }

  it('личный звонок один на один — roomKind sole, id возвращается строкой', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const id = await seedCall({ userId: 'u-deleted', roomName: 'voice_sole-1' });

    const plan = await discoverVoiceDeletion({ db, account, origin: 'explicit' });

    expect(plan.skips).toEqual([]);
    expect(plan.jobs).toEqual([
      {
        resourceType: 'voice.stop',
        resourceKey: id,
        phase: 'immediate',
        payload: { callId: id, externalBotId: null, roomKind: 'sole' },
      },
      {
        resourceType: 'voice.purge',
        resourceKey: id,
        phase: 'purge',
        payload: { callId: id },
      },
    ]);
  });

  it('звонок ДРУГОГО user_id в той же комнате — shared', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const id = await seedCall({ userId: 'u-deleted', roomName: 'room-shared' });
    await seedCall({ userId: 'u-other', roomName: 'room-shared' });

    const plan = await discoverVoiceDeletion({ db, account, origin: 'explicit' });

    // Чужой звонок в план не попадает (ни stop, ни purge), но делает комнату
    // общей.
    expect(stopsOf(plan.jobs)).toHaveLength(1);
    expect(stopsOf(plan.jobs)[0].payload).toEqual({ callId: id, externalBotId: null, roomKind: 'shared' });
    expect(purgesOf(plan.jobs).map((j) => j.resourceKey)).toEqual([id]);
  });

  it('звонок ТОГО ЖЕ user_id в той же комнате — sole (общей её делает только чужой участник)', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const a = await seedCall({ userId: 'u-deleted', roomName: 'room_SAME' });
    const b = await seedCall({ userId: 'u-deleted', roomName: 'room_SAME' });

    const plan = await discoverVoiceDeletion({ db, account, origin: 'explicit' });

    // Повторный вход того же пользователя (сегодня Роман, завтра снова Роман)
    // не делает комнату общей: SQL требует o.user_id <> c.user_id.
    expect(stopsOf(plan.jobs)).toHaveLength(2);
    const kinds = Object.fromEntries(stopsOf(plan.jobs).map((j) => [String(j.payload.callId), j.payload.roomKind]));
    expect(kinds).toEqual({ [a]: 'sole', [b]: 'sole' });
    expect(new Set(purgesOf(plan.jobs).map((j) => j.resourceKey))).toEqual(new Set([a, b]));
  });

  it('persistent незакрытая meeting_rooms room_<code> — shared без чужих звонков', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const id = await seedCall({ userId: 'u-deleted', roomName: 'room_ABC123' });
    await seedRoom('ABC123', 'u-other', false);

    const plan = await discoverVoiceDeletion({ db, account, origin: 'explicit' });

    expect(stopsOf(plan.jobs)).toHaveLength(1);
    expect(stopsOf(plan.jobs)[0].payload).toMatchObject({ callId: id, roomKind: 'shared' });
    expect(purgesOf(plan.jobs).map((j) => j.resourceKey)).toEqual([id]);
  });

  it('закрытая meeting_rooms комнату общей не делает; room-префикс без кода — тоже', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const closedRoom = await seedCall({ userId: 'u-deleted', roomName: 'room_OLD' });
    await seedRoom('OLD', 'u-deleted', true);
    // LIKE 'room\_%': дефис вместо подчёркивания не матчится, substr(...,6)
    // не находит кода — комната личная.
    const dashRoom = await seedCall({ userId: 'u-deleted', roomName: 'room-DEF' });
    await seedRoom('room-DEF'.slice(5), 'u-deleted', false);

    const plan = await discoverVoiceDeletion({ db, account, origin: 'explicit' });

    expect(stopsOf(plan.jobs)).toHaveLength(2);
    const kinds = Object.fromEntries(stopsOf(plan.jobs).map((j) => [String(j.payload.callId), j.payload.roomKind]));
    expect(kinds).toEqual({ [closedRoom]: 'sole', [dashRoom]: 'sole' });
  });

  it('generation predicate: чужой deletionId или живой аккаунт — план пустой', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    await seedCall({ userId: 'u-deleted', roomName: 'voice_gen-1' });

    const stale = await discoverVoiceDeletion({
      db,
      account: { ...account, deletionId: OLD_DELETION_ID },
      origin: 'explicit',
    });
    expect(stale.jobs).toEqual([]);

    await pool.query(`UPDATE user_id SET state='active', deletion_id=NULL, deleted_at=NULL WHERE internal_id='u-deleted'`);
    const reactivated = await discoverVoiceDeletion({ db, account, origin: 'explicit' });
    expect(reactivated.jobs).toEqual([]);
  });

  it('завершённый звонок с забытым ботом в плане есть, external_url не покидает базу', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const id = await seedCall({
      userId: 'u-deleted',
      roomName: 'zoom_leftover',
      status: 'completed',
      botId: 'bot-leftover',
      externalUrl: ZOOM_URL_CANARY,
    });

    const queries: string[] = [];
    const spyingDb = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        return pool.query(sql, params as any[]);
      },
    };
    const plan = await discoverVoiceDeletion({ db: spyingDb, account, origin: 'explicit' });

    expect(stopsOf(plan.jobs)).toHaveLength(1);
    expect(stopsOf(plan.jobs)[0].payload).toEqual({
      callId: id, externalBotId: 'bot-leftover', roomKind: 'sole',
    });
    // CANARY: ни payload, ни SQL discovery не содержат Zoom-адрес с токеном.
    for (const job of plan.jobs) {
      const payloadJson = JSON.stringify(job.payload);
      expect(payloadJson).not.toContain('CANARY-ZOOM-TOKEN');
      expect(payloadJson).not.toContain('http');
    }
    expect(queries.join('\n')).not.toContain('external_url');
  });

  it('voice.purge — все свои звонки любого статуса, чужие не попадают', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const active = await seedCall({ userId: 'u-deleted', roomName: 'voice_p-1' });
    const done = await seedCall({ userId: 'u-deleted', roomName: 'voice_p-2', status: 'completed' });
    const interrupted = await seedCall({ userId: 'u-deleted', roomName: 'voice_p-3', status: 'interrupted' });
    const foreign = await seedCall({ userId: 'u-other', roomName: 'voice_p-4', status: 'completed' });

    const plan = await discoverVoiceDeletion({ db, account, origin: 'explicit' });

    const keys = purgesOf(plan.jobs).map((j) => j.resourceKey).sort();
    expect(keys).toEqual([active, done, interrupted].sort());
    expect(keys).not.toContain(foreign);
    for (const job of purgesOf(plan.jobs)) {
      expect(job.phase).toBe('purge');
      expect(job.payload).toEqual({ callId: job.resourceKey });
    }
  });
});

/**
 * K1 — поздний complete() и фоновое резюме звонка после удаления аккаунта.
 *
 * Явное удаление стирает историю (core.immediate) один раз, повторного прохода
 * ядра нет. Звонок, который шёл в момент DELETE /webhook/profile, после
 * voice.stop присылает complete(): без гейта он перезаписывал транскрипт и
 * состав участников, а фоновое резюме дописывало карточку в
 * custom_chat_history — она жила бы вечно. Здесь SQL исполняется по-настоящему:
 * своя схема, реальные миграции voice_calls, прод-форма custom_chat_history.
 */
maybe('VoiceCallService.complete после удаления аккаунта против живого Postgres', () => {
  jest.setTimeout(30_000);

  const SCHEMA = `voice_k1_${process.pid}_${Date.now()}`;
  const USER = '79990000301';
  const ROOM = 'voice_k1-room';

  let admin: Pool;
  let pool: Pool;
  const issued: string[] = [];
  const pg = {
    query: async (sql: string, params?: unknown[]) => {
      const res = await pool.query(sql, params as any[]);
      issued.push(sql.replace(/\s+/g, ' ').trim());
      return res;
    },
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    for (const name of [
      '001_voice_calls.sql',
      '003_call_tokens.sql',
      '003_voice_call_origin.sql',
      '004_voice_call_end_reason.sql',
      '005_voice_call_participants.sql',
    ]) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', name), 'utf8'));
    }
    // internal_id — прод-тип (001_core_schema.sql: character varying NOT NULL,
    // UNIQUE user_id_internal_id_key), а не text: гейты сравнивают его с text-
    // колонками и параметрами, и расхождение типов должно ловиться здесь.
    await pool.query(`CREATE TABLE user_id (
      internal_id character varying NOT NULL UNIQUE,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    // Форма — как в profile-account-deletion.pg.spec.ts (001_core_schema.sql).
    await pool.query(`CREATE TABLE custom_chat_history (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      sender_type character varying(10) NOT NULL,
      agent integer,
      content text NOT NULL,
      created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
      message_type character varying(20) DEFAULT 'text'::character varying NOT NULL,
      tokens_used integer DEFAULT 0
    )`);
    await pool.query(`CREATE TABLE token_consumption_tasks (
      id serial PRIMARY KEY,
      execution_id bigint,
      user_id text,
      status text,
      agent_id integer,
      input_tokens integer,
      output_tokens integer,
      tokens_to_consume integer,
      metadata jsonb
    )`);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    issued.length = 0;
    await pool.query('TRUNCATE voice_calls, user_id, custom_chat_history, token_consumption_tasks CASCADE');
  });

  const STAGED = [{ role: 'user', text: 'staged-реплика', ts: 1 }];
  const payload: CompletePayload = {
    transcript: [
      { role: 'user', text: 'меня зовут Синтетик, я открываю пекарню', ts: 1 },
      { role: 'assistant', text: 'понял, расскажите о планах', ts: 2 },
    ],
    usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime' },
    participants: [{ name: 'Участник Синтетический', joinedAt: 1 }],
  } as CompletePayload;

  async function seed(state: 'active' | 'deleted', callStatus: string): Promise<string> {
    await pool.query(
      `INSERT INTO user_id (internal_id, state, deleted_at, deletion_id) VALUES ($1, $2, $3, $4)`,
      [USER, state, state === 'deleted' ? DELETED_AT : null, state === 'deleted' ? DELETION_ID : null],
    );
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, transcript)
       VALUES ($1, $2, 12, $3, $4, $5::jsonb)`,
      [id, USER, ROOM, callStatus, JSON.stringify(STAGED)],
    );
    return id;
  }

  function makeSvc(onSummary?: () => Promise<void>) {
    const chat = {
      generateAgentReply: jest.fn(async () => {
        if (onSummary) await onSummary();
        return 'синтетическое резюме разговора';
      }),
      consolidateAfterChatPublic: jest.fn(async () => {}),
    };
    const livekit = { userToken: jest.fn(), dispatchAgent: jest.fn(), send: jest.fn(async () => {}) };
    const svc = new VoiceCallService(pg as any, chat as any, livekit as any);
    return { svc, chat };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitIssued(re: RegExp, timeoutMs = 5_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!issued.some((s) => re.test(s))) {
      if (Date.now() > until) throw new Error(`не дождались запроса ${re}`);
      await sleep(20);
    }
  }

  async function callRow(id: string) {
    return (await pool.query(
      `SELECT status, transcript, participants, summary FROM voice_calls WHERE id = $1`,
      [id],
    )).rows[0];
  }
  async function historyCount(): Promise<number> {
    return (await pool.query(`SELECT count(*)::int AS n FROM custom_chat_history`)).rows[0].n;
  }

  it('удалённый аккаунт: complete не перезаписывает транскрипт и участников, карточки и консолидации нет', async () => {
    // voice.stop уже пометил звонок interrupted и закрыл комнату — воркер шлёт complete.
    const id = await seed('deleted', 'interrupted');
    const { svc, chat } = makeSvc();

    await svc.complete(id, payload);
    // Фоновому резюме (если оно запущено) — время дойти до записи.
    await sleep(300);

    const row = await callRow(id);
    expect(row.transcript).toEqual(STAGED);
    expect(row.participants).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.status).toBe('interrupted');
    expect(await historyCount()).toBe(0);
    expect(chat.consolidateAfterChatPublic).not.toHaveBeenCalled();
  });

  it('удалённый аккаунт: повторный complete не создаёт второй строки учёта', async () => {
    const id = await seed('deleted', 'interrupted');
    const { svc } = makeSvc();

    await svc.complete(id, payload);
    await svc.complete(id, payload);
    await sleep(300);

    const n = (await pool.query(`SELECT count(*)::int AS n FROM token_consumption_tasks`)).rows[0].n;
    expect(n).toBeLessThanOrEqual(1);
  });

  it('аккаунт удалён, пока считалось резюме: карточки в ленте и summary нет', async () => {
    const id = await seed('active', 'active');
    const { svc } = makeSvc(async () => {
      await pool.query(
        `UPDATE user_id SET state = 'deleted', deleted_at = $2, deletion_id = $3 WHERE internal_id = $1`,
        [USER, DELETED_AT, DELETION_ID],
      );
    });

    await svc.complete(id, payload);
    await waitIssued(/INSERT INTO custom_chat_history/);

    expect(await historyCount()).toBe(0);
    expect((await callRow(id)).summary).toBeNull();
  });

  it('активный аккаунт: транскрипт, участники, резюме и карточка пишутся как раньше', async () => {
    const id = await seed('active', 'active');
    const { svc, chat } = makeSvc();

    await svc.complete(id, payload);
    await waitIssued(/INSERT INTO custom_chat_history/);

    const row = await callRow(id);
    expect(row.status).toBe('completed');
    expect(row.transcript).toEqual(payload.transcript);
    expect(row.participants).toEqual([{ name: 'Участник Синтетический', joinedAt: 1 }]);
    expect(row.summary).toBe('синтетическое резюме разговора');
    const card = (await pool.query(
      `SELECT session_id, sender_type, agent, content FROM custom_chat_history`,
    )).rows;
    expect(card).toHaveLength(1);
    expect(card[0].session_id).toBe(`${USER}_${HOST_AGENT_ID}`);
    expect(card[0].sender_type).toBe('ai');
    expect(card[0].content).toContain(`{{voice_call: id=${id}}}`);
    expect(card[0].content).toContain('синтетическое резюме разговора');
    expect(chat.consolidateAfterChatPublic).toHaveBeenCalledTimes(1);
    const billing = (await pool.query(`SELECT user_id, status FROM token_consumption_tasks`)).rows;
    expect(billing).toEqual([{ user_id: USER, status: 'pending' }]);
  });
});
