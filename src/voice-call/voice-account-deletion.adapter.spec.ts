import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { safeDeletionJobSnapshot } from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { VoiceCallService } from './voice-call.service';
import { VoiceCallModule } from './voice-call.module';
import {
  VoiceAccountDeletionAdapter,
  discoverVoiceDeletion,
} from './voice-account-deletion.adapter';
import { readFileSync } from 'fs';

/**
 * Task 10 — voice/meetings при удалении аккаунта.
 *
 * Останавливаются ТОЛЬКО боты и доступ удалённого аккаунта: общие meeting
 * rooms и история других участников сохраняются. Неизвестный внешний исход
 * (Attendee null, LiveKit без подтверждения) — fail-closed retry, и внешний
 * ID сохраняется для повторной попытки. В payload попадают только технические
 * call/bot ID и roomKind — никогда external_url/Zoom URL.
 */

const ZOOM_URL_CANARY = 'https://zoom.us/j/123456?zak=CANARY-ZOOM-TOKEN';

interface FakeCallRow {
  id: string;
  user_id: string;
  room_name: string;
  status: string;
  external_bot_id: string | null;
  external_url?: string | null;
}

class FakeVoiceDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  calls: FakeCallRow[] = [];
  /** Звонки ДРУГИХ пользователей — канарейка: их строки трогать нельзя. */
  otherParticipantCalls: FakeCallRow[] = [];
  meetingRooms: Array<{ code: string; owner_user_id: string; closed_at: Date | null }> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];

  async query(sql: string, params: any[] = []) {
    this.queries.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT c.id, c.external_bot_id')) {
      if (!this.isCurrentDeletion(params[0], params[1])) return { rows: [], rowCount: 0 };
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
    if (s.startsWith('UPDATE voice_calls SET external_bot_id = NULL')) {
      const [callId, userId, deletionId] = params;
      if (!this.isCurrentDeletion(userId, deletionId)) return { rows: [], rowCount: 0 };
      const call = this.calls.find((c) => c.id === callId);
      if (!call || call.external_bot_id == null) return { rows: [], rowCount: 0 };
      call.external_bot_id = null;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE voice_calls SET status = 'interrupted'")) {
      const [callId, , deletionId] = params;
      const call = this.calls.find((c) => c.id === callId);
      if (!call) return { rows: [], rowCount: 0 };
      if (!this.isCurrentDeletion(call.user_id, deletionId)) return { rows: [], rowCount: 0 };
      if (!['dialing', 'active'].includes(call.status)) return { rows: [], rowCount: 0 };
      call.status = 'interrupted';
      return { rows: [{ room_name: call.room_name }], rowCount: 1 };
    }
    if (s.startsWith('SELECT status, room_name FROM voice_calls WHERE id')) {
      const call = this.calls.find((c) => c.id === params[0]);
      if (!call) return { rows: [], rowCount: 0 };
      return { rows: [{ status: call.status, room_name: call.room_name }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  private isCurrentDeletion(userId: string, deletionId: string): boolean {
    const user = this.users.get(userId);
    return user?.state === 'deleted' && user.deletionId === deletionId;
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
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = {
    db: db as any,
    assertCurrent: jest.fn(async () => {}),
  };
  return { db, livekit, attendee, voice, adapter, ctx, registry };
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

describe('discoverVoiceDeletion', () => {
  it('эмитит voice.stop только с call/bot ID — external_url не покидает базу', async () => {
    const { db } = makeHarness();
    seedSharedMeeting(db);

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.skips).toEqual([]);
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]).toEqual({
      resourceType: 'voice.stop',
      resourceKey: 'call-1',
      phase: 'immediate',
      payload: { callId: 'call-1', externalBotId: 'bot-external-1', roomKind: 'shared' },
    });
    // CANARY: ни payload, ни SQL discovery не содержат Zoom-адрес.
    const snapshot = safeDeletionJobSnapshot(plan.jobs[0], account.userId);
    expect(snapshot.payloadJson).not.toContain('CANARY-ZOOM-TOKEN');
    expect(snapshot.payloadJson).not.toContain('http');
    expect(db.queries.map((q) => q.sql).join('\n')).not.toContain('external_url');
  });

  it('личный звонок один на один — roomKind sole', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: 'call-2', user_id: account.userId, room_name: 'voice_call-2',
      status: 'dialing', external_bot_id: null,
    });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].payload).toEqual({
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

    expect(plan.jobs[0].payload).toMatchObject({ roomKind: 'shared' });
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
    expect(plan.jobs).toHaveLength(2);
    for (const job of plan.jobs) {
      expect(job.payload).toMatchObject({ roomKind: 'sole' });
    }
  });

  it('завершённый звонок без бота — задачи нет', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: 'call-4', user_id: account.userId, room_name: 'voice_call-4',
      status: 'completed', external_bot_id: null,
    });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([]);
  });

  it('завершённый звонок с забытым ботом — задача есть (бот обязан уйти)', async () => {
    const { db } = makeHarness();
    db.calls.push({
      id: 'call-5', user_id: account.userId, room_name: 'meet_call-5',
      status: 'interrupted', external_bot_id: 'bot-leftover',
    });

    const plan = await discoverVoiceDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].payload).toMatchObject({ externalBotId: 'bot-leftover' });
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

  it('resourceTypes — только voice.stop, registry регистрируется один раз', () => {
    const { adapter, registry } = makeHarness();
    expect(adapter.resourceTypes).toEqual(['voice.stop']);
    const register = jest.spyOn(registry, 'register');
    adapter.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(adapter);
    expect(registry.getExecutor('voice.stop')).toBe(adapter);
  });

  it('неподдерживаемый resourceType отклоняется', async () => {
    const { adapter, ctx } = makeHarness();
    const foreign = { ...stopJob({ callId: 'x' }), resourceType: 'voice.purge' as const, phase: 'purge' as const };
    await expect(adapter.execute(foreign, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });

  it('deletion-путь не импортирует RoomService (source-level канарка)', () => {
    // Общие комнаты закрывает RoomService.close (UPDATE meeting_rooms +
    // livekit.closeRoom) — закрытие общей комнаты из-за удаления ОДНОГО
    // аккаунта выкинуло бы остальных участников. Прежняя канарка (мок
    // roomService.close) была нечестной: roomService не внедрялся ни в один
    // объект harness'а и не мог быть вызван в принципе. Честная проверка — по
    // исходникам deletion-пути: ни импорта модуля, ни import-строки.
    for (const file of ['voice-account-deletion.adapter.ts', 'voice-call.service.ts']) {
      const src = readFileSync(`${__dirname}/${file}`, 'utf8');
      expect(file).not.toContain('room.service'); // страховка от опечатки в цикле
      expect(src).not.toContain('meeting/room.service');
      expect(src).not.toMatch(/^\s*import[^\n]*RoomService/m);
    }
  });

  it('VoiceCallModule подключает AccountDeletionModule и адаптер ровно один раз', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, VoiceCallModule) ?? [];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, VoiceCallModule) ?? [];
    const flatImports = imports.flat(Infinity);
    expect(flatImports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === VoiceAccountDeletionAdapter)).toHaveLength(1);
    const moduleSource = readFileSync(`${__dirname}/voice-call.module.ts`, 'utf8');
    expect(moduleSource).not.toContain('assertReady');
    expect(moduleSource).not.toContain('AccountDeletionRunner');
  });
});
