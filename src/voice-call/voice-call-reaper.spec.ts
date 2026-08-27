import { VoiceCallReaperService } from './voice-call-reaper.service';

describe('VoiceCallReaperService', () => {
  let pg: { query: jest.Mock };
  let livekit: { closeRoom: jest.Mock; removeAgents: jest.Mock };

  /** Ответ базы: подобрана одна зависшая строка нужного провайдера. */
  function stale(kind: 'call' | 'meeting', row: any) {
    const marker = kind === 'call' ? "provider = 'linkeon'" : "provider <> 'linkeon'";
    pg.query.mockImplementation(async (sql: string) =>
      sql.includes(marker) && sql.includes('UPDATE voice_calls')
        ? { rows: [row], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }

  beforeEach(() => {
    pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    livekit = { closeRoom: jest.fn(), removeAgents: jest.fn() };
  });

  function svc() {
    return new VoiceCallReaperService(pg as any, livekit as any);
  }

  it('порог для встречи больше, чем для звонка', async () => {
    // С общим часовым порогом реапер подбирал бы живые встречи на втором часу
    // и обрывал их как зависшие — то есть предохранитель убивал бы ровно то,
    // ради чего потолок и подняли.
    await svc().reap();
    const call = pg.query.mock.calls.find(
      ([s]: [string]) => s.includes("provider = 'linkeon'") && s.includes('UPDATE voice_calls'),
    );
    const meeting = pg.query.mock.calls.find(
      ([s]: [string]) => s.includes("provider <> 'linkeon'") && s.includes('UPDATE voice_calls'),
    );
    expect(call).toBeDefined();
    expect(meeting).toBeDefined();
    expect(Number(call![1][0])).toBeLessThan(Number(meeting![1][0]));
  });

  it('у зависшего звонка закрывает комнату — она создана ради него', async () => {
    stale('call', { id: 'c1', room_name: 'voice_c1' });
    await svc().reap();
    expect(livekit.closeRoom).toHaveBeenCalledWith('voice_c1');
  });

  it('у зависшей встречи выгоняет агента, но НЕ закрывает комнату с людьми', async () => {
    stale('meeting', { id: 'm1', room_name: 'room_ABC234' });
    await svc().reap();
    expect(livekit.removeAgents).toHaveBeenCalledWith('room_ABC234');
    expect(livekit.closeRoom).not.toHaveBeenCalled();
  });

  it('падение LiveKit не роняет планировщик', async () => {
    stale('meeting', { id: 'm1', room_name: 'room_ABC234' });
    livekit.removeAgents.mockRejectedValue(new Error('livekit down'));
    await expect(svc().reap()).resolves.toBeUndefined();
  });

  it('падение базы не роняет планировщик', async () => {
    pg.query.mockRejectedValue(new Error('база моргнула'));
    await expect(svc().reap()).resolves.toBeUndefined();
  });

  it('ничего не зависло — в LiveKit не ходим вовсе', async () => {
    await svc().reap();
    expect(livekit.closeRoom).not.toHaveBeenCalled();
    expect(livekit.removeAgents).not.toHaveBeenCalled();
  });
});
