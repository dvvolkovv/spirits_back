import { VoiceCallService } from './voice-call.service';
import { VoiceCallReaperService } from './voice-call-reaper.service';

describe('VoiceCallReaperService', () => {
  let pg: { query: jest.Mock };
  let livekit: { closeRoom: jest.Mock; removeAgents: jest.Mock };
  let attendee: { removeBot: jest.Mock };

  /** Ответ базы: подобрана одна зависшая строка нужного провайдера. */
  function stale(kind: 'call' | 'meeting', row: any) {
    const marker = kind === 'call' ? "provider = 'linkeon'" : "provider <> 'linkeon'";
    pg.query.mockImplementation(async (sql: string) =>
      sql.includes(marker) && sql.includes('UPDATE voice_calls')
        ? { rows: [row], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }

  /** Ответ базы для прохода повторных попыток: одна строка с забытым ботом. */
  function forgottenBot(row: { id: string; external_bot_id: string }) {
    pg.query.mockImplementation(async (sql: string) =>
      sql.includes('external_bot_id IS NOT NULL')
        ? { rows: [row], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }

  beforeEach(() => {
    pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    livekit = { closeRoom: jest.fn(), removeAgents: jest.fn() };
    attendee = { removeBot: jest.fn().mockResolvedValue(true) };
  });

  function svc(withAttendee: any = attendee) {
    // Реапер зовёт настоящий VoiceCallService: правило «как убирать бота»
    // живёт там, потому что нужно и на завершении звонка. Заглушки — только
    // вокруг (pg, livekit, Attendee), поэтому проверки ниже по-прежнему
    // проверяют поведение, а не факт делегирования.
    const calls = new VoiceCallService(
      pg as any, {} as any, livekit as any, undefined, undefined, withAttendee as any,
    );
    return new VoiceCallReaperService(pg as any, livekit as any, calls);
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

  it('у зависшей встречи с ботом Attendee выводит и его — иначе Chrome останется в чужой встрече', async () => {
    stale('meeting', { id: 'm1', room_name: 'room_ABC234', external_bot_id: 'bot_1' });
    await svc().reap();
    expect(attendee.removeBot).toHaveBeenCalledWith('bot_1');
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

  describe('повторные попытки вывести забытых ботов', () => {
    it('забытого бота выводит и обнуляет колонку', async () => {
      forgottenBot({ id: 'c1', external_bot_id: 'bot_1' });
      attendee.removeBot.mockResolvedValue(true);
      await svc().reap();
      expect(attendee.removeBot).toHaveBeenCalledWith('bot_1');
      expect(pg.query.mock.calls.some(([sql, args]: any) =>
        /UPDATE voice_calls SET external_bot_id = NULL/.test(sql) && args?.[0] === 'c1',
      )).toBe(true);
    });

    it('бота уже нет (false) — колонку тоже обнуляет: состояние известно', async () => {
      forgottenBot({ id: 'c1', external_bot_id: 'bot_1' });
      attendee.removeBot.mockResolvedValue(false);
      await svc().reap();
      expect(pg.query.mock.calls.some(([sql, args]: any) =>
        /UPDATE voice_calls SET external_bot_id = NULL/.test(sql) && args?.[0] === 'c1',
      )).toBe(true);
    });

    it('неизвестное состояние (null) — колонку НЕ обнуляет, попробует снова', async () => {
      // Иначе при перезапуске контейнера Attendee бот тихо остаётся в чужой
      // встрече, а мы про него забываем навсегда.
      forgottenBot({ id: 'c1', external_bot_id: 'bot_1' });
      attendee.removeBot.mockResolvedValue(null);
      await svc().reap();
      expect(pg.query.mock.calls.some(([sql]: any) =>
        /UPDATE voice_calls SET external_bot_id = NULL/.test(sql),
      )).toBe(false);
    });

    it('без Attendee реапер продолжает работать', async () => {
      // Он подбирает и обычные звонки — их уборка не должна зависеть от
      // того, настроен ли Attendee. Забытый бот в выборке есть, но без
      // клиента его некому вывести — sweepBot обязан тихо выйти, а не уронить
      // весь reap().
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes("provider = 'linkeon'") && sql.includes('UPDATE voice_calls')) {
          return { rows: [{ id: 'c1', room_name: 'voice_c1' }], rowCount: 1 };
        }
        if (sql.includes('external_bot_id IS NOT NULL')) {
          return { rows: [{ id: 'm1', external_bot_id: 'bot_1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      await expect(svc(undefined).reap()).resolves.toBeUndefined();
      expect(livekit.closeRoom).toHaveBeenCalledWith('voice_c1');
    });
  });
});
