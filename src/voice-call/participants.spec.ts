import { cleanParticipants, mergeParticipants, participantsLine } from './participants';

/**
 * Список участников встречи (voice_calls.participants).
 *
 * Владелец 03.11.2026: «на встречах записывать список участников». Список
 * копит воркер (voice-host/src/roster.ts) и шлёт его с транскриптом — в
 * progress по ходу встречи и в complete в конце.
 */
describe('cleanParticipants', () => {
  it('пропускает правильные записи', () => {
    expect(cleanParticipants([{ name: 'Аня', joinedAt: 1000 }])).toEqual([{ name: 'Аня', joinedAt: 1000 }]);
  });

  it('не массив — пустой список: воркер прежней версии поля не шлёт', () => {
    expect(cleanParticipants(undefined)).toEqual([]);
    expect(cleanParticipants('Аня')).toEqual([]);
  });

  it('выбрасывает записи без имени и без времени', () => {
    expect(cleanParticipants([
      { name: '', joinedAt: 1 },
      { name: '  ', joinedAt: 1 },
      { name: 'Без времени' },
      { name: 'Плохое время', joinedAt: 'вчера' },
      null,
      { name: 'Борис', joinedAt: 2 },
    ])).toEqual([{ name: 'Борис', joinedAt: 2 }]);
  });

  it('обрезает длинное имя и ограничивает длину списка', () => {
    const long = 'я'.repeat(500);
    expect(cleanParticipants([{ name: long, joinedAt: 1 }])[0].name).toHaveLength(200);
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `p${i}`, joinedAt: i }));
    expect(cleanParticipants(many)).toHaveLength(300);
  });
});

describe('mergeParticipants', () => {
  it('объединяет по имени и берёт самое раннее время', () => {
    expect(mergeParticipants(
      [{ name: 'Аня', joinedAt: 1000 }, { name: 'Борис', joinedAt: 3000 }],
      [{ name: 'аня', joinedAt: 2000 }, { name: 'Вера', joinedAt: 4000 }],
    )).toEqual([
      { name: 'Аня', joinedAt: 1000 },
      { name: 'Борис', joinedAt: 3000 },
      { name: 'Вера', joinedAt: 4000 },
    ]);
  });

  it('упорядочивает по времени входа', () => {
    expect(mergeParticipants([{ name: 'Поздний', joinedAt: 9 }], [{ name: 'Ранний', joinedAt: 1 }])
      .map((p) => p.name)).toEqual(['Ранний', 'Поздний']);
  });
});

describe('participantsLine', () => {
  it('строка для сообщения о встрече', () => {
    expect(participantsLine([{ name: 'Аня', joinedAt: 1 }, { name: 'Борис', joinedAt: 2 }]))
      .toBe('Участники: Аня, Борис.');
  });

  it('пустой список — пустая строка: у звонка участников не пишем', () => {
    expect(participantsLine([])).toBe('');
  });
});
