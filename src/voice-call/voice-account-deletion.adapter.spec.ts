import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  safeDeletionJobSnapshot,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { VoiceCallService } from './voice-call.service';
import { VoiceCallModule } from './voice-call.module';
import { DOCS_BUCKET } from './voice-call.types';
import { voiceDocumentKey } from './voice-document-key';
import {
  VoiceAccountDeletionAdapter,
  discoverVoiceDeletion,
} from './voice-account-deletion.adapter';
import { VoiceDocumentAccountDeletionAdapter } from './voice-document-account-deletion';
import { readFileSync } from 'fs';

/**
 * Task 10 + Task 15 — voice/meetings и голосовые документы при удалении аккаунта.
 *
 * Останавливаются ТОЛЬКО боты и доступ удалённого аккаунта: общие meeting
 * rooms и история других участников сохраняются. Неизвестный внешний исход
 * (Attendee null, LiveKit без подтверждения, MinIO без подтверждения) —
 * fail-closed retry, и внешний ID сохраняется для повторной попытки. В payload
 * попадают только технические call/bot/doc ID — никогда external_url/Zoom URL,
 * тексты и userId: legacy-папка документа вычисляется из job.userId в execute.
 *
 * Порядок Task 15: объекты документов удаляются ДО строк voice_calls
 * (voice.purge ждёт всех voice-document.purge правилом каталога); сбой MinIO
 * сохраняет call/job строки и external IDs.
 */

const ZOOM_URL_CANARY = 'https://zoom.us/j/123456?zak=CANARY-ZOOM-TOKEN';

// Солёный хэш папки документов считается через relayFsKey: соль обязана быть
// выставлена ДО вычисления констант модуля.
const OLD_SALT = process.env.RELAY_FS_SALT;
process.env.RELAY_FS_SALT = 'voice-deletion-unit-spec';
afterAll(() => {
  if (OLD_SALT === undefined) delete process.env.RELAY_FS_SALT;
  else process.env.RELAY_FS_SALT = OLD_SALT;
});

const DOC_ID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
const DOC_ID_2 = 'aaaaaaaa-1111-4222-8333-cccccccccccc';
const HASHED_KEY = voiceDocumentKey('u-deleted', DOC_ID) as string;
const LEGACY_KEY = `documents/u-deleted/${DOC_ID_2}.md`;
const DOC_URL = `https://minio.test/${DOCS_BUCKET}/${HASHED_KEY}`;
const LEGACY_DOC_URL = `https://minio.test/${DOCS_BUCKET}/${LEGACY_KEY}`;
const TEXT_CANARY = 'ЛИЧНЫЙ-ТЕКСТ-ДОКУМЕНТА';
const CALL_UUID = 'cccccccc-0000-4000-8000-0000000000a1';
const OTHER_CALL_UUID = 'cccccccc-0000-4000-8000-0000000000b2';

interface FakeCallRow {
  id: string;
  user_id: string;
  room_name: string;
  status: string;
  external_bot_id: string | null;
  external_url?: string | null;
  transcript?: unknown;
  summary?: string | null;
}

class FakeVoiceDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  calls: FakeCallRow[] = [];
  /** Звонки ДРУГИХ пользователей — канарейка: их строки трогать нельзя. */
  otherParticipantCalls: FakeCallRow[] = [];
  voiceCallJobs: Array<{ id: string; call_id: string; question: string; answer?: string | null }> = [];
  meetingRooms: Array<{ code: string; owner_user_id: string; closed_at: Date | null }> = [];
  // Площадки ref-check (CHAT_FILE_REF_PLACES): достаточно пустых массивов,
  // ссылки seed'ятся только там, где тест их кладёт.
  history: Array<{ id: number; session_id: string; content: string }> = [];
  generatedImages: Array<{ user_id: string; image_url: string }> = [];
  videoJobs: Array<{ id: string; user_id: string }> = [];
  speechClips: Array<{ id: string; user_id: string }> = [];
  actionPlans: Array<{ user_id: string; summary?: string | null; items?: unknown }> = [];
  tasks: Array<{ id: string; user_id: string; summary?: string | null; claudemd?: string | null }> = [];
  taskEvents: Array<{ task_id: string; content: string }> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];

  async query(sql: string, params: any[] = []) {
    this.queries.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT c.id, c.external_bot_id')) {
      if (!this.isDeletionCurrent(params[0], params[1])) return { rows: [], rowCount: 0 };
      const rows = this.calls
        .filter((c) => c.user_id === params[0]
          && (['dialing', 'active'].includes(c.status) || c.external_bot_id != null))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => ({
          id: c.id,
          external_bot_id: c.external_bot_id,
          // Семантика прод-SQL: комната общая только при звонке ДРУГОГО
          // user_id (o.user_id <> c.user_id). Повторный вход того же
          // пользователя общую комнату не создаёт.
          shared_room: [...this.calls, ...this.otherParticipantCalls]
            .some((o) => o.room_name === c.room_name && o.user_id !== c.user_id),
          persistent_room: c.room_name.startsWith('room_')
            && this.meetingRooms.some((m) => m.code === c.room_name.slice(5) && m.closed_at === null),
        }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT c.id FROM voice_calls c')) {
      // Discovery voice.purge: ВСЕ звонки аккаунта (любой статус).
      if (!this.isDeletionCurrent(params[0], params[1])) return { rows: [], rowCount: 0 };
      const rows = this.calls
        .filter((c) => c.user_id === params[0])
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => ({ id: c.id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('UPDATE voice_calls SET external_bot_id = NULL')) {
      const [callId, userId, deletionId] = params;
      if (!this.isDeletionCurrent(userId, deletionId)) return { rows: [], rowCount: 0 };
      const call = this.calls.find((c) => c.id === callId);
      if (!call || call.external_bot_id == null) return { rows: [], rowCount: 0 };
      call.external_bot_id = null;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE voice_calls SET status = 'interrupted'")) {
      const [callId, , deletionId] = params;
      const call = this.calls.find((c) => c.id === callId);
      if (!call) return { rows: [], rowCount: 0 };
      if (!this.isDeletionCurrent(call.user_id, deletionId)) return { rows: [], rowCount: 0 };
      if (!['dialing', 'active'].includes(call.status)) return { rows: [], rowCount: 0 };
      call.status = 'interrupted';
      return { rows: [{ room_name: call.room_name }], rowCount: 1 };
    }
    if (s.startsWith('SELECT status, room_name FROM voice_calls WHERE id')) {
      const call = this.calls.find((c) => c.id === params[0]);
      if (!call) return { rows: [], rowCount: 0 };
      return { rows: [{ status: call.status, room_name: call.room_name }], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM voice_calls')) {
      // DELETE с generation predicate: [callId, userId, deletionId].
      const [callId, userId, deletionId] = params;
      if (!this.isDeletionCurrent(userId, deletionId)) return { rows: [], rowCount: 0 };
      const idx = this.calls.findIndex((c) => c.id === callId && c.user_id === userId);
      if (idx < 0) return { rows: [], rowCount: 0 };
      this.calls.splice(idx, 1);
      // FK voice_call_jobs.call_id ON DELETE CASCADE (001_voice_calls.sql).
      this.voiceCallJobs = this.voiceCallJobs.filter((j) => j.call_id !== callId);
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT count(*)::int AS total')) {
      // Ref-check документов: те же count(total)/count FILTER(own) запросы,
      // что строит адаптер из CHAT_FILE_REF_PLACES.
      const table = /FROM (\w+)/.exec(s)?.[1] ?? '';
      const userId = String(params[0]);
      const needles = params.slice(1).map(String).filter(Boolean);
      let total = 0;
      let own = 0;
      for (const row of this.rowsOf(table)) {
        const hay = JSON.stringify(row);
        if (!needles.some((n) => hay.includes(n))) continue;
        total += 1;
        if (this.isOwnRow(table, row, userId)) own += 1;
      }
      return { rows: [{ total, own }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isDeletionCurrent(userId: string, deletionId: string): boolean {
    const user = this.users.get(userId);
    return user?.state === 'deleted' && user.deletionId === deletionId;
  }

  private rowsOf(table: string): any[] {
    switch (table) {
      case 'custom_chat_history': return this.history;
      case 'generated_images': return this.generatedImages;
      case 'video_jobs': return this.videoJobs;
      case 'speech_clips': return this.speechClips;
      case 'voice_calls': return [...this.calls, ...this.otherParticipantCalls];
      case 'voice_call_jobs': return this.voiceCallJobs;
      case 'action_plans': return this.actionPlans;
      case 'tasks': return this.tasks;
      case 'task_events': return this.taskEvents;
      default: return [];
    }
  }

  private isOwnRow(table: string, row: any, userId: string): boolean {
    switch (table) {
      case 'custom_chat_history':
        return String(row.session_id ?? '').startsWith(`${userId}_`);
      case 'voice_call_jobs': {
        const parent = [...this.calls, ...this.otherParticipantCalls]
          .find((c) => c.id === row.call_id);
        return parent?.user_id === userId;
      }
      case 'task_events': {
        const parent = this.tasks.find((t) => t.id === row.task_id);
        return parent?.user_id === userId;
      }
      default:
        return row.user_id === userId;
    }
  }
}

const deletionId = '7f9c2a1e-3b4d-4e5f-8a6b-9c0d1e2f3a4b';
const account: DeletionAccount = {
  userId: 'u-deleted',
  deletionId,
  deletedAt: new Date('2026-11-11T00:00:00Z'),
};

function stopJob(payload: Record<string, unknown>): DeletionJobRow {
  return {
    id: `job-voice-stop-${payload.callId}`,
    deletionId,
    userId: account.userId,
    resourceType: 'voice.stop',
    resourceKey: String(payload.callId),
    phase: 'immediate',
    payload,
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-11T00:00:00Z'),
    leaseUntil: new Date('2026-11-11T01:00:00Z'),
    lastErrorKind: null,
  };
}

function purgeJob(callId: string): DeletionJobRow {
  return {
    id: `job-voice-purge-${callId}`,
    deletionId,
    userId: account.userId,
    resourceType: 'voice.purge',
    resourceKey: callId,
    phase: 'purge',
    payload: { callId },
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-11T00:00:00Z'),
    leaseUntil: new Date('2026-12-11T01:00:00Z'),
    lastErrorKind: null,
  };
}

function docJob(payload: Record<string, unknown>): DeletionJobRow {
  return {
    id: `job-voice-doc-${payload.docId}`,
    deletionId,
    userId: account.userId,
    resourceType: 'voice-document.purge',
    resourceKey: `doc-${payload.docId}`,
    phase: 'purge',
    payload,
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-11T00:00:00Z'),
    leaseUntil: new Date('2026-12-11T01:00:00Z'),
    lastErrorKind: null,
  };
}

function makeHarness() {
  const db = new FakeVoiceDb();
  db.users.set(account.userId, { state: 'deleted', deletionId });
  const livekit = {
    closeRoomStrict: jest.fn(async () => true),
    removeAgentsStrict: jest.fn(async () => true),
    closeRoom: jest.fn(async () => {}),
    removeAgents: jest.fn(async () => {}),
    send: jest.fn(async () => {}),
    userToken: jest.fn(async () => 'tok'),
    dispatchAgent: jest.fn(async () => {}),
  };
  const attendee = { removeBot: jest.fn(async (): Promise<boolean | null> => true) };
  const voice = new VoiceCallService(
    db as any, {} as any, livekit as any, undefined, undefined, attendee as any,
  );
  const registry = new AccountDeletionRegistry();
  const adapter = new VoiceAccountDeletionAdapter(voice, attendee as any, registry);
  const storage = {
    deleteConfirmed: jest.fn(async (): Promise<'deleted' | 'absent'> => 'deleted'),
    delete: jest.fn(async () => undefined),
  };
  const docAdapter = new VoiceDocumentAccountDeletionAdapter(storage as any, registry);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = {
    db: db as any,
    assertCurrent: jest.fn(async () => {}),
  };
  return { db, livekit, attendee, voice, adapter, docAdapter, storage, ctx, registry };
}

/** ctx, у которого assertCurrent честно проверяет поколение удалённого аккаунта. */
function strictCtx(db: FakeVoiceDb): DeletionExecution & { assertCurrent: jest.Mock } {
  return {
    db: db as any,
    assertCurrent: jest.fn(async (job: DeletionJobRow) => {
      if (!db.isDeletionCurrent(job.userId, job.deletionId)) throw new DeletionCancelledError();
    }),
  };
}

/** Встреча в общей комнате: другой участник + persistent meeting_rooms. */
function seedSharedMeeting(db: FakeVoiceDb, overrides: Partial<FakeCallRow> = {}) {
  db.calls.push({
    id: 'call-1',
    user_id: account.userId,
    room_name: 'room-shared',
    status: 'active',
    external_bot_id: 'bot-external-1',
    external_url: ZOOM_URL_CANARY,
    ...overrides,
  });
  db.otherParticipantCalls.push({
    id: 'call-other',
    user_id: 'u-other',
    room_name: 'room-shared',
    status: 'active',
    external_bot_id: null,
  });
  db.meetingRooms.push({ code: 'SHARED', owner_user_id: 'u-other', closed_at: null });
}

const stopsOf = (jobs: readonly { resourceType: string }[]) =>
  jobs.filter((j) => j.resourceType === 'voice.stop');
const purgesOf = (jobs: readonly { resourceType: string }[]) =>
  jobs.filter((j) => j.resourceType === 'voice.purge');

describe('discoverVoiceDeletion', () => {
  it('эмитит voice.stop только с call/bot ID — external_url не покидает базу', async () => {
    const { db } = makeHarness();
    seedSharedMeeting(db);

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.skips).toEqual([]);
    expect(stopsOf(plan.jobs)).toHaveLength(1);
    expect(stopsOf(plan.jobs)[0]).toEqual({
      resourceType: 'voice.stop',
      resourceKey: 'call-1',
      phase: 'immediate',
      payload: { callId: 'call-1', externalBotId: 'bot-external-1', roomKind: 'shared' },
    });
    // Task 15: каждый звонок получает purge-задачу с техническим callId.
    expect(purgesOf(plan.jobs)).toEqual([{
      resourceType: 'voice.purge',
      resourceKey: 'call-1',
      phase: 'purge',
      payload: { callId: 'call-1' },
    }]);
    // CANARY: ни payload, ни SQL discovery не содержат Zoom-адрес.
    for (const job of plan.jobs) {
      const snapshot = safeDeletionJobSnapshot(job, account.userId);
      expect(snapshot.payloadJson).not.toContain('CANARY-ZOOM-TOKEN');
      expect(snapshot.payloadJson).not.toContain('http');
    }
    expect(db.queries.map((q) => q.sql).join('\n')).not.toContain('external_url');
  });

  it('личный звонок один на один — roomKind sole', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: 'call-2', user_id: account.userId, room_name: 'voice_call-2',
      status: 'dialing', external_bot_id: null,
    });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(stopsOf(plan.jobs)).toHaveLength(1);
    expect(stopsOf(plan.jobs)[0].payload).toEqual({
      callId: 'call-2', externalBotId: null, roomKind: 'sole',
    });
  });

  it('persistent meeting_rooms даёт shared даже без звонков других участников', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: 'call-3', user_id: account.userId, room_name: 'room_ABC123',
      status: 'active', external_bot_id: null,
    });
    db.meetingRooms.push({ code: 'ABC123', owner_user_id: account.userId, closed_at: null });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(stopsOf(plan.jobs)[0].payload).toMatchObject({ roomKind: 'shared' });
  });

  it('звонок ТОГО ЖЕ user_id в той же комнате — sole (общей её делает только чужой участник)', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: 'call-20', user_id: account.userId, room_name: 'room_SAME',
      status: 'active', external_bot_id: null,
    });
    db.calls.push({
      id: 'call-21', user_id: account.userId, room_name: 'room_SAME',
      status: 'active', external_bot_id: null,
    });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    // Повторный вход того же пользователя (сегодня Роман, завтра снова Роман)
    // не делает комнату общей — фейк обязан повторять семантику SQL
    // (o.user_id <> c.user_id), а не считать общим любой второй звонок.
    expect(stopsOf(plan.jobs)).toHaveLength(2);
    for (const job of stopsOf(plan.jobs)) {
      expect(job.payload).toMatchObject({ roomKind: 'sole' });
    }
  });

  it('завершённый звонок без бота — stop нет, voice.purge есть', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: 'call-4', user_id: account.userId, room_name: 'voice_call-4',
      status: 'completed', external_bot_id: null,
    });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(stopsOf(plan.jobs)).toEqual([]);
    expect(purgesOf(plan.jobs)).toEqual([{
      resourceType: 'voice.purge',
      resourceKey: 'call-4',
      phase: 'purge',
      payload: { callId: 'call-4' },
    }]);
  });

  it('завершённый звонок с забытым ботом — задача есть (бот обязан уйти)', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: 'call-5', user_id: account.userId, room_name: 'meet_call-5',
      status: 'interrupted', external_bot_id: 'bot-leftover',
    });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(stopsOf(plan.jobs)).toHaveLength(1);
    expect(stopsOf(plan.jobs)[0].payload).toMatchObject({ externalBotId: 'bot-leftover' });
    expect(purgesOf(plan.jobs)).toHaveLength(1);
  });

  it('voice.purge — только свои звонки, чужие строки в план не попадают', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'room-shared',
      status: 'completed', external_bot_id: null,
    });
    db.otherParticipantCalls.push({
      id: OTHER_CALL_UUID, user_id: 'u-other', room_name: 'room-shared',
      status: 'completed', external_bot_id: null,
    });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(purgesOf(plan.jobs).map((j) => j.resourceKey)).toEqual([CALL_UUID]);
  });

  it('reactivated аккаунт (не текущее поколение) — план пустой', async () => {
    const { db } = makeHarness();
    seedSharedMeeting(db);
    db.users.set(account.userId, { state: 'active', deletionId: null });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([]);
  });
});

describe('VoiceAccountDeletionAdapter — voice.stop', () => {
  const voiceStopJob = stopJob({
    callId: 'call-1', externalBotId: 'bot-external-1', roomKind: 'shared',
  });

  it('Attendee null сохраняет external_bot_id и не завершает stop', async () => {
    const { db, adapter, ctx, attendee, livekit } = makeHarness();
    seedSharedMeeting(db);
    attendee.removeBot.mockResolvedValue(null);

    await expect(adapter.execute(voiceStopJob, ctx)).rejects.toMatchObject({ kind: 'external_unknown' });
    expect(db.calls[0].external_bot_id).toBe('bot-external-1');
    expect(voiceStopJob.payload).toEqual({ callId: 'call-1', externalBotId: 'bot-external-1', roomKind: 'shared' });
    // Звонок не помечен остановленным: исход бота неизвестен.
    expect(db.calls[0].status).toBe('active');
    expect(livekit.removeAgentsStrict).not.toHaveBeenCalled();
    expect(livekit.closeRoomStrict).not.toHaveBeenCalled();
  });

  it('сбой removeBot (исключение) — то же fail-closed поведение, что и null', async () => {
    const { db, adapter, ctx, attendee } = makeHarness();
    seedSharedMeeting(db);
    attendee.removeBot.mockRejectedValue(new Error('network down'));

    await expect(adapter.execute(voiceStopJob, ctx)).rejects.toMatchObject({ kind: 'external_unknown' });
    expect(db.calls[0].external_bot_id).toBe('bot-external-1');
    expect(db.calls[0].status).toBe('active');
  });

  it('shared room не закрывается, удаляются только agents удалённого аккаунта', async () => {
    const { db, adapter, ctx, attendee, livekit } = makeHarness();
    seedSharedMeeting(db);
    attendee.removeBot.mockResolvedValue(true);

    await adapter.execute(voiceStopJob, ctx);

    expect(livekit.removeAgentsStrict).toHaveBeenCalledWith('room-shared');
    expect(livekit.closeRoomStrict).not.toHaveBeenCalled();
    // RoomService.close здесь не проверить моком — он в deletion-путь не
    // внедряется вовсе; запрет закреплён source-level тестом ниже.
    expect(db.meetingRooms).toHaveLength(1);
    expect(db.otherParticipantCalls).toHaveLength(1);
    // Строки других участников не меняются.
    expect(db.otherParticipantCalls[0].status).toBe('active');
    expect(db.calls[0].status).toBe('interrupted');
    expect(db.calls[0].external_bot_id).toBeNull();
  });

  it('sole personal room закрывается strict-методом', async () => {
    const { db, adapter, ctx, livekit } = makeHarness();
    db.calls.push({
      id: 'call-9', user_id: account.userId, room_name: 'voice_call-9',
      status: 'active', external_bot_id: null,
    });

    await adapter.execute(stopJob({ callId: 'call-9', externalBotId: null, roomKind: 'sole' }), ctx);

    expect(livekit.closeRoomStrict).toHaveBeenCalledWith('voice_call-9');
    expect(livekit.removeAgentsStrict).not.toHaveBeenCalled();
    expect(db.calls[0].status).toBe('interrupted');
  });

  it('неизвестный исход LiveKit (closeRoomStrict false) сохраняет retry', async () => {
    const { db, adapter, ctx, livekit } = makeHarness();
    db.calls.push({
      id: 'call-10', user_id: account.userId, room_name: 'voice_call-10',
      status: 'active', external_bot_id: null,
    });
    livekit.closeRoomStrict.mockResolvedValue(false);

    await expect(
      adapter.execute(stopJob({ callId: 'call-10', externalBotId: null, roomKind: 'sole' }), ctx),
    ).rejects.toMatchObject({ kind: 'external_unknown' });
  });

  it('неизвестный исход LiveKit в shared room (removeAgentsStrict false) сохраняет retry', async () => {
    const { db, adapter, ctx, attendee, livekit } = makeHarness();
    seedSharedMeeting(db);
    attendee.removeBot.mockResolvedValue(true);
    livekit.removeAgentsStrict.mockResolvedValue(false);

    await expect(adapter.execute(voiceStopJob, ctx)).rejects.toMatchObject({ kind: 'external_unknown' });
  });

  it('call без external_bot_id — только markInterrupted*, Attendee не зовётся', async () => {
    const { db, adapter, ctx, attendee, livekit } = makeHarness();
    db.calls.push({
      id: 'call-11', user_id: account.userId, room_name: 'voice_call-11',
      status: 'active', external_bot_id: null,
    });

    await adapter.execute(stopJob({ callId: 'call-11', externalBotId: null, roomKind: 'sole' }), ctx);

    expect(attendee.removeBot).not.toHaveBeenCalled();
    expect(livekit.closeRoomStrict).toHaveBeenCalledWith('voice_call-11');
  });

  it('removeBot false (бот уже вышел) — confirmed, колонка чистится', async () => {
    const { db, adapter, ctx, attendee } = makeHarness();
    seedSharedMeeting(db);
    attendee.removeBot.mockResolvedValue(false);

    await adapter.execute(voiceStopJob, ctx);

    expect(db.calls[0].external_bot_id).toBeNull();
    expect(db.calls[0].status).toBe('interrupted');
  });

  it('уже interrupted call — подтверждённый успех, не external_unknown', async () => {
    const { db, adapter, ctx, livekit } = makeHarness();
    db.calls.push({
      id: 'call-12', user_id: account.userId, room_name: 'voice_call-12',
      status: 'interrupted', external_bot_id: null,
    });
    livekit.closeRoomStrict.mockResolvedValue(true);

    await expect(
      adapter.execute(stopJob({ callId: 'call-12', externalBotId: null, roomKind: 'sole' }), ctx),
    ).resolves.toBeUndefined();
  });

  it('повторный execute после успеха идемпотентен', async () => {
    const { db, adapter, ctx, attendee } = makeHarness();
    seedSharedMeeting(db);
    attendee.removeBot.mockResolvedValue(true);

    await adapter.execute(voiceStopJob, ctx);
    // Повтор: бот уже выведен (false), звонок уже interrupted.
    attendee.removeBot.mockResolvedValue(false);
    await expect(adapter.execute(voiceStopJob, ctx)).resolves.toBeUndefined();
  });

  it('reactivation посреди stop — fail-closed retry, чужой звонок не тронут', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedSharedMeeting(db);
    db.users.set(account.userId, { state: 'active', deletionId: null });

    await expect(adapter.execute(voiceStopJob, ctx)).rejects.toMatchObject({ kind: 'external_unknown' });
    expect(db.calls[0].status).toBe('active');
  });

  it('assertCurrent зовётся до и после внешних шагов', async () => {
    const { db, adapter, ctx, attendee } = makeHarness();
    seedSharedMeeting(db);
    attendee.removeBot.mockResolvedValue(true);

    await adapter.execute(voiceStopJob, ctx);

    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of ctx.assertCurrent.mock.calls) {
      expect(call[0]).toBe(voiceStopJob);
    }
  });
});

describe('VoiceAccountDeletionAdapter — voice.purge', () => {
  it('удаляет свою строку, voice_call_jobs уходит FK-каскадом, чужое не тронуто', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'room-shared',
      status: 'completed', external_bot_id: null,
      transcript: [{ role: 'user', text: `документ ${DOC_URL} ${TEXT_CANARY}` }],
    });
    db.voiceCallJobs.push({ id: 'job-1', call_id: CALL_UUID, question: 'вопрос', answer: 'ответ' });
    db.otherParticipantCalls.push({
      id: OTHER_CALL_UUID, user_id: 'u-other', room_name: 'room-shared',
      status: 'completed', external_bot_id: null,
    });
    db.meetingRooms.push({ code: 'SHARED', owner_user_id: 'u-other', closed_at: null });

    await adapter.execute(purgeJob(CALL_UUID), ctx);

    expect(db.calls).toHaveLength(0);
    expect(db.voiceCallJobs).toHaveLength(0);
    // Общая комната и чужой звонок сохраняются.
    expect(db.otherParticipantCalls).toHaveLength(1);
    expect(db.meetingRooms).toHaveLength(1);
  });

  it('нет строки — идемпотентный успех', async () => {
    const { adapter, ctx } = makeHarness();

    await expect(
      adapter.execute(purgeJob('dddddddd-0000-4000-8000-0000000000ff'), ctx),
    ).resolves.toBeUndefined();
  });

  it('повторный execute после удаления — идемпотентный успех', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'voice_x',
      status: 'completed', external_bot_id: null,
    });

    await adapter.execute(purgeJob(CALL_UUID), ctx);
    await expect(adapter.execute(purgeJob(CALL_UUID), ctx)).resolves.toBeUndefined();
    expect(db.calls).toHaveLength(0);
  });

  it('reactivation — cancelled до DELETE, строка на месте', async () => {
    const { db, adapter } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'voice_x',
      status: 'completed', external_bot_id: null,
    });
    db.users.set(account.userId, { state: 'active', deletionId: null });

    await expect(
      adapter.execute(purgeJob(CALL_UUID), strictCtx(db)),
    ).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.calls).toHaveLength(1);
  });

  it('чужой deletionId (старое поколение) — generation predicate не даёт удалить', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'voice_x',
      status: 'completed', external_bot_id: null,
    });
    const stale = { ...purgeJob(CALL_UUID), deletionId: '88888888-0000-4000-8000-000000000000' };

    await adapter.execute(stale, ctx);

    expect(db.calls).toHaveLength(1);
  });

  it('callId не-UUID в payload — retry kind db, DELETE не выполняется', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'voice_x',
      status: 'completed', external_bot_id: null,
    });

    await expect(
      adapter.execute({ ...purgeJob(CALL_UUID), payload: { callId: 'not-a-uuid' } }, ctx),
    ).rejects.toMatchObject({ kind: 'db' });
    expect(db.calls).toHaveLength(1);
    expect(db.queries.some((q) => q.sql.startsWith('DELETE'))).toBe(false);
  });

  it('assertCurrent зовётся до DELETE и после', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'voice_x',
      status: 'completed', external_bot_id: null,
    });
    const job = purgeJob(CALL_UUID);

    await adapter.execute(job, ctx);

    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of ctx.assertCurrent.mock.calls) {
      expect(call[0]).toBe(job);
    }
  });
});

describe('VoiceDocumentAccountDeletionAdapter — voice-document.purge', () => {
  const hashedJob = docJob({ docId: DOC_ID, keyKind: 'hashed' });

  it('MinIO document failure сохраняет call/job rows и external IDs', async () => {
    const { db, docAdapter, ctx, storage } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'room-shared',
      status: 'active', external_bot_id: 'bot-1',
      transcript: [{ role: 'user', text: `документ ${DOC_URL} ${TEXT_CANARY}` }],
    });
    db.voiceCallJobs.push({ id: 'job-1', call_id: CALL_UUID, question: 'q', answer: 'a' });
    storage.deleteConfirmed.mockRejectedValue({ response: { status: 503 } });

    await expect(docAdapter.execute(hashedJob, ctx)).rejects.toMatchObject({ kind: 'external_5xx' });

    expect(db.calls).toHaveLength(1);
    expect(db.voiceCallJobs).toHaveLength(1);
    expect(db.calls[0].external_bot_id).toBe('bot-1');
    expect(storage.deleteConfirmed).toHaveBeenCalledWith({ bucket: DOCS_BUCKET, key: HASHED_KEY });
  });

  it('неизвестный исход MinIO (нет статуса) — external_unknown, объект не «удалён» молча', async () => {
    const { db, docAdapter, ctx, storage } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'voice_x',
      status: 'completed', external_bot_id: null,
    });
    storage.deleteConfirmed.mockRejectedValue(new Error('socket hang up'));

    await expect(docAdapter.execute(hashedJob, ctx)).rejects.toMatchObject({ kind: 'external_unknown' });
    expect(db.calls).toHaveLength(1);
  });

  it('чужая ссылка (tasks u-other) — shared document сохраняется, job успешен', async () => {
    const { db, docAdapter, ctx, storage } = makeHarness();
    db.tasks.push({ id: 'task-other', user_id: 'u-other', summary: `см. ${DOC_URL}` });

    await expect(docAdapter.execute(hashedJob, ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('чужой transcript звонка — объект сохраняется', async () => {
    const { db, docAdapter, ctx, storage } = makeHarness();
    db.otherParticipantCalls.push({
      id: OTHER_CALL_UUID, user_id: 'u-other', room_name: 'room-shared',
      status: 'completed', external_bot_id: null,
      transcript: [{ role: 'user', text: DOC_URL }],
    });

    await expect(docAdapter.execute(hashedJob, ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('собственная ссылка НЕ блокирует удаление: строки уйдут позже через voice.purge', async () => {
    const { db, docAdapter, ctx, storage } = makeHarness();
    db.calls.push({
      id: CALL_UUID, user_id: account.userId, room_name: 'voice_x',
      status: 'completed', external_bot_id: null,
      transcript: [{ role: 'user', text: DOC_URL }],
    });

    await expect(docAdapter.execute(hashedJob, ctx)).resolves.toBeUndefined();

    // Порядок «references, затем rows»: объект удалён, строка ещё на месте —
    // её удалит voice.purge (allOf-зависимость в каталоге).
    expect(storage.deleteConfirmed).toHaveBeenCalledWith({ bucket: DOCS_BUCKET, key: HASHED_KEY });
    expect(db.calls).toHaveLength(1);
  });

  it('legacy keyKind: ключ вычисляется из job.userId, в payload его нет', async () => {
    const { docAdapter, ctx, storage } = makeHarness();
    const legacy = docJob({ docId: DOC_ID_2, keyKind: 'legacy' });
    // CANARY: payload не содержит ни папки, ни userId, ни URL.
    expect(JSON.stringify(legacy.payload)).not.toContain('u-deleted');
    expect(legacy.payload).toEqual({ docId: DOC_ID_2, keyKind: 'legacy' });

    await expect(docAdapter.execute(legacy, ctx)).resolves.toBeUndefined();

    expect(storage.deleteConfirmed).toHaveBeenCalledWith({
      bucket: DOCS_BUCKET,
      key: `documents/u-deleted/${DOC_ID_2}.md`,
    });
  });

  it('payload мимо sanitizer не проходит: docId+keyKind безопасны', () => {
    const snapshot = safeDeletionJobSnapshot(hashedJob, account.userId);
    expect(snapshot.payloadJson).not.toContain('u-deleted');
    expect(snapshot.payloadJson).not.toContain('http');
    expect(snapshot.payloadJson).not.toContain(TEXT_CANARY);
  });

  it('невалидный docId или keyKind — retry kind db, MinIO не зовётся', async () => {
    const { docAdapter, ctx, storage } = makeHarness();

    await expect(
      docAdapter.execute(docJob({ docId: 'not-a-uuid', keyKind: 'hashed' }), ctx),
    ).rejects.toMatchObject({ kind: 'db' });
    await expect(
      docAdapter.execute(docJob({ docId: DOC_ID, keyKind: 'raw' }), ctx),
    ).rejects.toMatchObject({ kind: 'db' });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('reactivation — cancelled до ref-check и MinIO', async () => {
    const { db, docAdapter, storage } = makeHarness();
    db.users.set(account.userId, { state: 'active', deletionId: null });

    await expect(
      docAdapter.execute(hashedJob, strictCtx(db)),
    ).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('reactivation посреди execute (после ref-check) — fail-closed, объект не удалён', async () => {
    const { db, docAdapter, storage } = makeHarness();
    let calls = 0;
    const ctx: DeletionExecution = {
      db: db as any,
      assertCurrent: async (job: DeletionJobRow) => {
        calls += 1;
        if (calls >= 2) {
          db.users.set(account.userId, { state: 'active', deletionId: null });
          throw new DeletionCancelledError();
        }
        expect(job).toBe(hashedJob);
      },
    };

    await expect(docAdapter.execute(hashedJob, ctx)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('повторный execute после успеха идемпотентен', async () => {
    const { docAdapter, ctx, storage } = makeHarness();

    await docAdapter.execute(hashedJob, ctx);
    await expect(docAdapter.execute(hashedJob, ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(2);
  });

  it('assertCurrent зовётся до внешних шагов и после удаления', async () => {
    const { docAdapter, ctx } = makeHarness();

    await docAdapter.execute(hashedJob, ctx);

    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of ctx.assertCurrent.mock.calls) {
      expect(call[0]).toBe(hashedJob);
    }
  });

  it('storage.delete из deletion-пути не вызывается — только deleteConfirmed', async () => {
    const { docAdapter, ctx, storage } = makeHarness();

    await docAdapter.execute(hashedJob, ctx);

    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(1);
  });

  it('resourceTypes — voice-document.purge, registry регистрируется один раз', () => {
    const { docAdapter, registry } = makeHarness();
    expect(docAdapter.resourceTypes).toEqual(['voice-document.purge']);
    const register = jest.spyOn(registry, 'register');
    docAdapter.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(docAdapter);
    expect(registry.getExecutor('voice-document.purge')).toBe(docAdapter);
  });
});

describe('VoiceAccountDeletionAdapter — контракт', () => {
  it('resourceTypes — voice.stop и voice.purge, registry регистрируется один раз', () => {
    const { adapter, registry } = makeHarness();
    expect(adapter.resourceTypes).toEqual(['voice.stop', 'voice.purge']);
    const register = jest.spyOn(registry, 'register');
    adapter.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(adapter);
    expect(registry.getExecutor('voice.stop')).toBe(adapter);
    expect(registry.getExecutor('voice.purge')).toBe(adapter);
  });

  it('неподдерживаемый resourceType отклоняется', async () => {
    const { adapter, ctx } = makeHarness();
    const foreign = { ...stopJob({ callId: 'x' }), resourceType: 'chat-file.purge' as const };
    await expect(adapter.execute(foreign, ctx)).rejects.toThrow('unsupported_deletion_resource');
    const { docAdapter } = makeHarness();
    await expect(docAdapter.execute(stopJob({ callId: 'x' }), ctx)).rejects
      .toThrow('unsupported_deletion_resource');
  });

  it('deletion-путь не импортирует RoomService (source-level канарка)', () => {
    // Общие комнаты закрывает RoomService.close (UPDATE meeting_rooms +
    // livekit.closeRoom) — закрытие общей комнаты из-за удаления ОДНОГО
    // аккаунта выкинуло бы остальных участников. Прежняя канарка (мок
    // roomService.close) была нечестной: roomService не внедрялся ни в один
    // объект harness'а и не мог быть вызван в принципе. Честная проверка — по
    // исходникам deletion-пути: ни импорта модуля, ни import-строки.
    for (const file of [
      'voice-account-deletion.adapter.ts',
      'voice-call.service.ts',
      'voice-document-account-deletion.ts',
    ]) {
      const src = readFileSync(`${__dirname}/${file}`, 'utf8');
      expect(file).not.toContain('room.service'); // страховка от опечатки в цикле
      expect(src).not.toContain('meeting/room.service');
      expect(src).not.toMatch(/^\s*import[^\n]*RoomService/m);
    }
  });

  it('VoiceCallModule подключает AccountDeletionModule и оба адаптера ровно один раз', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, VoiceCallModule) ?? [];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, VoiceCallModule) ?? [];
    const flatImports = imports.flat(Infinity);
    expect(flatImports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === VoiceAccountDeletionAdapter)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === VoiceDocumentAccountDeletionAdapter)).toHaveLength(1);
    const moduleSource = readFileSync(`${__dirname}/voice-call.module.ts`, 'utf8');
    expect(moduleSource).not.toContain('assertReady');
    expect(moduleSource).not.toContain('AccountDeletionRunner');
  });
});
