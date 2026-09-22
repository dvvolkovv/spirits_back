import { formatMeetingFailure } from './meeting-alert';

describe('алерт о несостоявшемся входе', () => {
  it('называет площадку, этап и причину', () => {
    const text = formatMeetingFailure({
      stage: 'встреча',
      provider: 'telemost',
      reason: 'порт 8140 занят — Meet уже держит одну встречу',
      callId: '38da3f84',
      userId: '79030169187',
      room: '65470621881811',
    });
    expect(text).toContain('Ассистент не зашёл на встречу');
    expect(text).toContain('площадка: telemost');
    expect(text).toContain('этап: встреча');
    expect(text).toContain('порт 8140 занят');
    expect(text).toContain('встреча: 65470621881811');
    expect(text).toContain('звонок: 38da3f84');
  });

  it('без необязательных полей не печатает пустых строк', () => {
    const text = formatMeetingFailure({ stage: 'проверка настроек', reason: 'нет ключа' });
    expect(text).toContain('площадка: неизвестно');
    expect(text.split('\n').filter((l) => l.endsWith(': ')).length).toBe(0);
    expect(text).not.toContain('звонок:');
  });

  it('разметку в причине экранирует', () => {
    // Причина приезжает из воркера и моста — там бывает что угодно, вплоть до
    // обрывков HTML. Неэкранированный текст Telegram просто не отправит, и
    // алерт потеряется ровно тогда, когда он нужнее всего.
    const text = formatMeetingFailure({ stage: 'встреча', reason: '<b>сбой</b> & точка' });
    expect(text).toContain('&lt;b&gt;сбой&lt;/b&gt; &amp; точка');
  });
});
