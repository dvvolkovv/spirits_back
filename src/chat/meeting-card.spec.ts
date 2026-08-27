import { buildMeetingCard } from './meeting-card';

describe('buildMeetingCard', () => {
  it('собирает тег с кодом и названием', () => {
    expect(buildMeetingCard('ABC234', 'Планёрка')).toBe(
      '{{meeting_join: code=ABC234 title=Планёрка}}',
    );
  });

  it('вычищает фигурные скобки — иначе разбор на фронте рвётся', () => {
    // Название задаёт пользователь. Скобка внутри ломает регулярку, и вместо
    // карточки он видит сырой текст тега.
    expect(buildMeetingCard('ABC234', 'Пла}}нёрка')).toBe(
      '{{meeting_join: code=ABC234 title=Планёрка}}',
    );
  });

  it('схлопывает переводы строк — тег однострочный', () => {
    expect(buildMeetingCard('ABC234', 'Планёрка\nво вторник')).toBe(
      '{{meeting_join: code=ABC234 title=Планёрка во вторник}}',
    );
  });

  it('переживает пустое название', () => {
    expect(buildMeetingCard('ABC234', '')).toBe('{{meeting_join: code=ABC234 title=Встреча}}');
  });

  it('переживает отсутствующее название', () => {
    expect(buildMeetingCard('ABC234', undefined as any)).toBe(
      '{{meeting_join: code=ABC234 title=Встреча}}',
    );
  });

  it('обрезает слишком длинное название', () => {
    const card = buildMeetingCard('ABC234', 'а'.repeat(500));
    expect(card.length).toBeLessThan(300);
  });
});
