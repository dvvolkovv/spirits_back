import { endVerdict } from './end-reason';

/**
 * ⚠️ Чем кончился звонок: человек попрощался или связь порвалась.
 *
 * Разница нужна Роману при перезвоне (спека §4.8): «разговор оборвался» и
 * «разговор закончился» — это два разных начала следующего разговора. До
 * 29.10.2026 сервер их не различал вовсе: воркер в обоих случаях сообщал
 * `participant_disconnected`, и строка писалась `completed`.
 *
 * Правду знает LiveKit: у уходящего участника есть СВОЯ причина отключения,
 * и `CLIENT_INITIATED` («клиент сам вызвал disconnect») отличается от
 * `SIGNAL_CLOSE` («websocket закрылся неожиданно»).
 *
 * ⚠️ Главное правило этого разбора — НЕ ДОГАДЫВАТЬСЯ. Пока причина ухода
 * участника неизвестна, вердикт `unknown`, а не «наверное, попрощался».
 * Соврать здесь хуже, чем промолчать: Роман скажет человеку «ты попрощался»
 * про разговор, который у того оборвался на полуслове.
 */
describe('endVerdict: отчего кончился звонок', () => {
  it('клиент сам отключился — человек положил трубку', () => {
    expect(endVerdict('client_initiated', 'participant_disconnected')).toBe('hangup');
  });

  it('websocket закрылся неожиданно — связь потеряна', () => {
    expect(endVerdict('signal_close', 'participant_disconnected')).toBe('lost');
  });

  it('сервер выкинул участника по таймауту — тоже потеря связи', () => {
    expect(endVerdict('connection_timeout', 'participant_disconnected')).toBe('lost');
  });

  it('комнату закрыли мы сами — это не поступок человека', () => {
    expect(endVerdict('room_deleted', 'participant_disconnected')).toBe('reaped');
    expect(endVerdict('participant_removed', 'participant_disconnected')).toBe('reaped');
  });

  it('перезапуск SFU — инфраструктура, не человек', () => {
    expect(endVerdict('server_shutdown', 'participant_disconnected')).toBe('reaped');
  });

  it('сессию закрыли мы: потолок длительности', () => {
    expect(endVerdict(undefined, 'user_initiated')).toBe('limit');
  });

  it('сбой самой сессии', () => {
    expect(endVerdict(undefined, 'error')).toBe('error');
  });

  it('⚠️ ГЛАВНОЕ: причина ухода неизвестна — вердикт «неизвестно», а не догадка', () => {
    // Ровно это приходило до правки и выдавалось за нормальное прощание.
    expect(endVerdict(undefined, 'participant_disconnected')).toBe('unknown');
    expect(endVerdict('', '')).toBe('unknown');
    expect(endVerdict(undefined, undefined)).toBe('unknown');
  });

  it('незнакомый код LiveKit не выдаём за прощание', () => {
    expect(endVerdict('sip_trunk_failure', 'participant_disconnected')).toBe('unknown');
  });

  it('регистр и пробелы от SDK разбор не ломают', () => {
    expect(endVerdict('CLIENT_INITIATED', 'participant_disconnected')).toBe('hangup');
    expect(endVerdict(' Signal_Close ', undefined)).toBe('lost');
  });
});
