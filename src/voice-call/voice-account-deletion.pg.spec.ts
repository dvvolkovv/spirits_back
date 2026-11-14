import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { discoverVoiceDeletion } from './voice-account-deletion.adapter';

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

const stopsOf = (jobs: readonly { resourceType: string }[]) =>
  jobs.filter((j) => j.resourceType === 'voice.stop');
const purgesOf = (jobs: readonly { resourceType: string }[]) =>
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
