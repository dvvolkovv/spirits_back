import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { MeetWebhookController } from './meet-webhook.controller';
import { canonicalJson } from './attendee-signature';
import { createHmac } from 'crypto';

const SECRET = 's1';
const sign = (p: unknown) => createHmac('sha256', SECRET).update(canonicalJson(p), 'utf8').digest('base64');

describe('MeetWebhookController', () => {
  let livekit: { send: jest.Mock };
  let calls: { load: jest.Mock; isActive: jest.Mock };
  let ctl: MeetWebhookController;

  beforeEach(() => {
    process.env.ATTENDEE_WEBHOOK_SECRET = SECRET;
    livekit = { send: jest.fn().mockResolvedValue(undefined) };
    calls = {
      load: jest.fn().mockResolvedValue({ id: 'c1', room_name: 'meet_c1', status: 'active' }),
      isActive: jest.fn().mockReturnValue(true),
    };
    ctl = new MeetWebhookController(livekit as any, calls as any);
  });

  const hook = (trigger: string, data: unknown, key = 'k1') => ({
    idempotency_key: key, bot_id: 'b1', bot_metadata: { callId: 'c1' }, trigger, data,
  });

  it('вход участника уходит в комнату звонка', async () => {
    const p = hook('participant_events.join_leave', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'join', timestamp_ms: 1,
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).toHaveBeenCalledWith('meet_c1', {
      v: 1, type: 'meet_participant', event: 'join', uuid: 'u1', name: 'Сергей',
    });
  });

  it('выход участника тоже', async () => {
    const p = hook('participant_events.join_leave', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'leave', timestamp_ms: 2,
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1].event).toBe('leave');
  });

  it('говорящий уходит отдельным событием', async () => {
    const p = hook('participant_events.speech_start_stop', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'speech_start',
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1]).toEqual({
      v: 1, type: 'meet_speaking', uuid: 'u1', name: 'Сергей', speaking: true,
    });
  });

  it('замолчал — speaking false', async () => {
    const p = hook('participant_events.speech_start_stop', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'speech_stop',
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1].speaking).toBe(false);
  });

  it('смертельное состояние бота помечается fatal', async () => {
    const p = hook('bot.state_change', { new_state: 'fatal_error', old_state: 'joining' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1]).toEqual({
      v: 1, type: 'meet_bot_state', state: 'fatal_error', fatal: true,
    });
  });

  it('встреча закончилась — тоже fatal', async () => {
    const p = hook('bot.state_change', { new_state: 'ended', old_state: 'joined_recording' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1].fatal).toBe(true);
  });

  it('комната ожидания НЕ смертельна', async () => {
    // waiting_room — это ожидание впуска, а не отказ. Считать его
    // смертельным значило бы выходить ровно тогда, когда хозяин собирается
    // нас впустить.
    const p = hook('bot.state_change', { new_state: 'waiting_room', old_state: 'joining' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1]).toEqual({
      v: 1, type: 'meet_bot_state', state: 'waiting_room', fatal: false,
    });
  });

  it('промежуточные состояния входа не смертельны', async () => {
    for (const st of ['joining', 'joined_not_recording', 'joined_recording', 'connecting']) {
      livekit.send.mockClear();
      const p = hook('bot.state_change', { new_state: st, old_state: 'ready' }, `k-${st}`);
      await ctl.receive(sign(p), p as any);
      expect(livekit.send.mock.calls[0][1].fatal).toBe(false);
    }
  });

  it('обычное состояние бота не считается смертельным', async () => {
    const p = hook('bot.state_change', { new_state: 'joined_recording', old_state: 'joining' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1].fatal).toBe(false);
  });

  it('повтор по idempotency_key не дублируется', async () => {
    // Attendee ретраит настойчиво (до 30 раз), а дубль «вошёл» копил бы
    // участников в Presence на стороне воркера.
    const p = hook('participant_events.join_leave', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'join', timestamp_ms: 1,
    });
    await ctl.receive(sign(p), p as any);
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).toHaveBeenCalledTimes(1);
  });

  it('разные события того же бота не глушат друг друга', async () => {
    const a = hook('participant_events.join_leave', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'join', timestamp_ms: 1,
    }, 'k1');
    const b = hook('participant_events.join_leave', {
      participant_name: 'Дмитрий', participant_uuid: 'u2', event_type: 'join', timestamp_ms: 2,
    }, 'k2');
    await ctl.receive(sign(a), a as any);
    await ctl.receive(sign(b), b as any);
    expect(livekit.send).toHaveBeenCalledTimes(2);
  });

  it('плохая подпись — 401 и ничего не отправлено', async () => {
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive('мусор', p as any)).rejects.toThrow(UnauthorizedException);
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('несовпадение подписи попадает в лог вместе с канонизацией', async () => {
    // Иначе расхождение канонизации (например, из-за дробного числа в
    // event_metadata — Python пишет «1.0», JS после JSON.parse «1») будет
    // неотличимо от подделки, а выглядеть будет как молчаливое отсутствие
    // присутствия, то есть как сорванный в solo гейт.
    const warn = jest.spyOn((ctl as any).logger, 'warn').mockImplementation(() => {});
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive('мусор', p as any)).rejects.toThrow(UnauthorizedException);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bot.state_change'));
  });

  it('без секрета — 503', async () => {
    delete process.env.ATTENDEE_WEBHOOK_SECRET;
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).rejects.toThrow(ServiceUnavailableException);
  });

  it('событие без callId в метаданных игнорируется молча', async () => {
    // Это могут быть события бота, заведённого не нами — например, вручную
    // в UI Attendee. Ошибкой отвечать нельзя: Attendee начнёт ретраить.
    const p = { idempotency_key: 'k9', bot_id: 'b1', trigger: 'bot.state_change', data: { new_state: 'joined' } };
    await expect(ctl.receive(sign(p), p as any)).resolves.toEqual({ ok: true });
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('завершённый звонок не получает событий', async () => {
    calls.isActive.mockReturnValue(false);
    const p = hook('bot.state_change', { new_state: 'joined' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('неизвестный звонок не роняет ручку', async () => {
    calls.load.mockRejectedValue(new Error('нет такого'));
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).resolves.toEqual({ ok: true });
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('незнакомый триггер игнорируется', async () => {
    const p = hook('transcript.update', { speaker_name: 'Сергей' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('падение отправки в комнату не роняет ручку', async () => {
    // Комната могла быть уже удалена. Ответить ошибкой значит заставить
    // Attendee ретраить 30 раз впустую.
    livekit.send.mockRejectedValue(new Error('room not found'));
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).resolves.toEqual({ ok: true });
  });

  it('при переполнении вытесняет старые ключи, а не растёт бесконечно', async () => {
    // Воркер живёт неделями; множество без потолка росло бы всю его жизнь.
    const p = (i: number) => hook('participant_events.join_leave', {
      participant_name: 'Ч', participant_uuid: `u${i}`, event_type: 'join', timestamp_ms: i,
    }, `key${i}`);
    for (let i = 0; i < 5_100; i++) await ctl.receive(sign(p(i)), p(i) as any);
    expect((ctl as any).seen.size).toBeLessThanOrEqual(5_000);
  });
});
