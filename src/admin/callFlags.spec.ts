import { countUserTurns, callFlags } from './callFlags';

describe('countUserTurns', () => {
  it('считает только реплики человека', () => {
    const t = [
      { ts: 1, role: 'assistant', text: 'Привет' },
      { ts: 2, role: 'user', text: 'Здравствуй' },
      { ts: 3, role: 'assistant', text: 'Слушаю' },
      { ts: 4, role: 'user', text: 'Вопрос' },
    ];
    expect(countUserTurns(t)).toBe(2);
  });

  it('мусор вместо массива не роняет: расшифровки может не быть вовсе', () => {
    expect(countUserTurns(null)).toBe(0);
    expect(countUserTurns(undefined)).toBe(0);
    expect(countUserTurns('строка' as any)).toBe(0);
    expect(countUserTurns([] as any)).toBe(0);
    expect(countUserTurns([{ role: 'user' }] as any)).toBe(1);
  });
});

describe('callFlags', () => {
  const реплики = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ts: i, role: 'user', text: 'а' }));

  it('прерванный звонок помечен и других пометок не получает', () => {
    expect(callFlags({ status: 'interrupted', duration_sec: null, transcript: null }))
      .toEqual(['interrupted']);
  });

  it('человек не сказал ни слова', () => {
    expect(callFlags({
      status: 'completed', duration_sec: 120,
      transcript: [{ ts: 1, role: 'assistant', text: 'Алло' }],
    })).toContain('silent');
  });

  it('одна-две реплики — почти молчал', () => {
    expect(callFlags({ status: 'completed', duration_sec: 120, transcript: реплики(1) }))
      .toContain('nearly_silent');
    expect(callFlags({ status: 'completed', duration_sec: 120, transcript: реплики(2) }))
      .toContain('nearly_silent');
  });

  it('три реплики — уже нормальный разговор', () => {
    expect(callFlags({ status: 'completed', duration_sec: 120, transcript: реплики(3) }))
      .toEqual([]);
  });

  it('короткий завершённый звонок', () => {
    expect(callFlags({ status: 'completed', duration_sec: 12, transcript: реплики(5) }))
      .toEqual(['short']);
  });

  it('короткий И молчаливый получает обе пометки', () => {
    expect(callFlags({ status: 'completed', duration_sec: 5, transcript: [] }).sort())
      .toEqual(['short', 'silent']);
  });

  it('сорвавшаяся встреча — «сбой», а не «человек молчал»', () => {
    // Бот не вошёл во встречу: реплик и длительности нет. Причина лежит в
    // саммари («Звонок не состоялся: …»), а «молчал» увело бы разбор не туда.
    expect(callFlags({ status: 'failed', duration_sec: null, transcript: null }))
      .toEqual(['failed']);
  });

  it('обрыв посреди разговора — тоже только «сбой»', () => {
    // Стенд, 22.09.2026: звук Телемоста оборвался на 161-й секунде после
    // восьми реплик. Строка без пометок выдала бы его за нормальный разговор.
    expect(callFlags({ status: 'failed', duration_sec: 161, transcript: реплики(8) }))
      .toEqual(['failed']);
  });

  it('идущая сессия не считается ни молчанием, ни коротким звонком', () => {
    // Длительности до завершения нет, а расшифровку voice-host дописывает по
    // ходу (VoiceCallService.progress) — пометки по ней врали бы.
    expect(callFlags({ status: 'active', duration_sec: null, transcript: реплики(1) }))
      .toEqual(['live']);
    expect(callFlags({ status: 'dialing', duration_sec: null, transcript: null }))
      .toEqual(['live']);
  });
});
