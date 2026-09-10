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

  it('карточка встречи Meet несёт провайдера и код', () => {
    expect(buildMeetingCard('abc-defg-hij', 'Планёрка', 'meet'))
      .toBe('{{meeting_join: provider=meet code=abc-defg-hij title=Планёрка}}');
  });

  it('своя карточка осталась байт в байт прежней', () => {
    // В истории их накопилось, и менять формат задним числом значит сломать
    // разбор старых сообщений на фронте.
    expect(buildMeetingCard('ABC234', 'Планёрка')).toBe('{{meeting_join: code=ABC234 title=Планёрка}}');
  });
});

describe('адрес входа в карточке (Zoom)', () => {
  it('url идёт после кода и перед заголовком', () => {
    // Порядок не косметика: заголовок читается «до закрывающих скобок», и
    // стоя перед url он съел бы и его.
    const card = buildMeetingCard(
      '71077562785', 'Встреча Zoom', 'zoom',
      'https://us04web.zoom.us/j/71077562785?pwd=SECRET.1',
    );
    expect(card).toBe(
      '{{meeting_join: provider=zoom code=71077562785 ' +
      'url=https://us04web.zoom.us/j/71077562785?pwd=SECRET.1 title=Встреча Zoom}}',
    );
  });

  it('без адреса карточка остаётся прежней', () => {
    // Формат своих и Meet-карточек обязан не измениться: в истории их уже
    // накопилось, и разбор старых сообщений на фронте сломать нельзя.
    expect(buildMeetingCard('abc-defg-hij', 'Встреча', 'meet'))
      .toBe('{{meeting_join: provider=meet code=abc-defg-hij title=Встреча}}');
    expect(buildMeetingCard('ABC234', 'Планёрка'))
      .toBe('{{meeting_join: code=ABC234 title=Планёрка}}');
  });

  it('адрес с пробелом или скобкой выбрасывается целиком', () => {
    // Битый тег в ленте хуже карточки без адреса: вторая честно откажет при
    // входе, первый покажет мусор.
    const card = buildMeetingCard('71077562785', 'Встреча Zoom', 'zoom', 'https://x/j/1 2');
    expect(card).toBe('{{meeting_join: provider=zoom code=71077562785 url= title=Встреча Zoom}}');
  });
});
