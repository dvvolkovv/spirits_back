import { isCrisisConversation, isCrisisText } from './crisis';

describe('кризисные разговоры', () => {
  it.each([
    'Позвоните на линию МЧС: +7 (495) 989-50-50',
    'Линия МЧС 8 (495) 989 50 50',
    'Детский телефон доверия 8-800-2000-122',
    'детский телефон 88002000122',
  ])('номер в ответе: %s', (s) => {
    expect(isCrisisText(s)).toBe(true);
  });

  it('словесная форма из звонка', () => {
    expect(isCrisisText('плюс семь, четыреста девяносто пять, девятьсот восемьдесят девять, пятьдесят, пятьдесят')).toBe(true);
    expect(isCrisisText('восемь, восемьсот, две тысячи, сто двадцать два')).toBe(true);
  });

  it('одно «112» кризисом не считается — слишком частое число', () => {
    expect(isCrisisText('позвоните 112, если что')).toBe(false);
  });

  it('считается только ответ ассистента: номер от человека — не протокол', () => {
    expect(isCrisisConversation([{ role: 'user', text: 'мой номер 8-800-2000-122?' }])).toBe(false);
    expect(isCrisisConversation([{ role: 'assistant', text: 'телефон доверия 8-800-2000-122' }])).toBe(true);
  });
});
