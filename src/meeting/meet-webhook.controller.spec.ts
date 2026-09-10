import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { MeetWebhookController } from './meet-webhook.controller';
import { canonicalJson } from './attendee-signature';
import { createHmac } from 'crypto';

// Секрет — base64, как его отдаёт интерфейс Attendee; ключом HMAC служат
// его декодированные байты.
const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const sign = (p: unknown) =>
  createHmac('sha256', Buffer.from(SECRET, 'base64')).update(canonicalJson(p), 'utf8').digest('base64');

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

  it('вебхуки состава и речи больше не наши — в комнату ничего не уходит', async () => {
    // Раньше состав встречи приезжал вебхуками, потому что своя комната была
    // пуста по замыслу. С синхронизацией участники сидят в этой самой
    // комнате, и события даёт LiveKit — теми же событиями, что в своих
    // комнатах. Подписку на эти триггеры мы сняли (см. TRIGGERS в
    // attendee.client.ts), но мост мог отправить их по старой подписке
    // существующего бота: тогда сообщение просто игнорируется.
    for (const trigger of ['participant_events.join_leave', 'participant_events.speech_start_stop']) {
      livekit.send.mockClear();
      const p = hook(trigger, {
        participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'join',
      }, `k-${trigger}`);
      await ctl.receive(sign(p), p as any);
      expect(livekit.send).not.toHaveBeenCalled();
    }
  });

  it('смертельное состояние бота помечается fatal', async () => {
    const p = hook('bot.state_change', { new_state: 'fatal_error', old_state: 'joining' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1]).toEqual({
      v: 1, type: 'meet_bot_state', state: 'fatal_error', fatal: true,
    });
  });

  it('код причины доезжает до воркера', async () => {
    // Без него в базе оказывалось «бот Attendee: fatal_error» и для «никто не
    // нажал Впустить», и для упавшего Chrome. Живой прогон 09.09.2026: payload
    // несёт event_type=could_not_join_meeting,
    // event_sub_type=request_to_join_denied.
    const p = hook('bot.state_change', {
      new_state: 'fatal_error', old_state: 'joining',
      event_type: 'could_not_join_meeting', event_sub_type: 'request_to_join_denied',
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1]).toEqual({
      v: 1, type: 'meet_bot_state', state: 'fatal_error', fatal: true,
      sub: 'request_to_join_denied',
    });
  });

  it('без подтипа берётся тип события', async () => {
    // event_sub_type у Attendee часто null — тогда единственная зацепка это
    // event_type, и терять её нельзя.
    const p = hook('bot.state_change', {
      new_state: 'ended', old_state: 'leaving', event_type: 'left_meeting', event_sub_type: null,
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1].sub).toBe('left_meeting');
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
    // Attendee ретраит настойчиво (до 30 раз), а дубль состояния бота
    // означал бы второй выход из встречи по уже отработанной причине.
    const p = hook('bot.state_change', { new_state: 'waiting_room', old_state: 'joining' });
    await ctl.receive(sign(p), p as any);
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).toHaveBeenCalledTimes(1);
  });

  it('разные события того же бота не глушат друг друга', async () => {
    const a = hook('bot.state_change', { new_state: 'waiting_room', old_state: 'joining' }, 'k1');
    const b = hook('bot.state_change', { new_state: 'joined_recording', old_state: 'waiting_room' }, 'k2');
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
