import { parseNewsSelection } from './blog-news.parse';

describe('parseNewsSelection', () => {
  it('чистый JSON разбирается', () => {
    const out = parseNewsSelection('{"picks":[{"theme":"meeting-bot","headline":"Встречу можно записать"}]}');
    expect(out).toEqual([{ theme: 'meeting-bot', headline: 'Встречу можно записать' }]);
  });

  it('JSON в markdown-заборе разбирается', () => {
    const raw = 'Посмотрел неделю:\n```json\n{"picks":[{"theme":"trip","headline":"Маршрут одной кнопкой"}]}\n```\nГотово.';
    expect(parseNewsSelection(raw)[0].theme).toBe('trip');
  });

  it('JSON без языка в заборе разбирается', () => {
    expect(parseNewsSelection('```\n{"picks":[]}\n```')).toEqual([]);
  });

  it('пустой список — нормальный ответ, а не ошибка', () => {
    expect(parseNewsSelection('{"picks":[]}')).toEqual([]);
  });

  it('вежливая обвязка вокруг пустого списка не мешает', () => {
    expect(parseNewsSelection('На этой неделе рассказывать нечего. {"picks": []}')).toEqual([]);
  });

  it('пустой ответ релея — ошибка, а не «новостей нет»', () => {
    // Молчание релея и осознанное «ничего не выбрал» — разные события.
    // Свести их в пустой список значило бы не заметить отвалившийся отбор.
    expect(() => parseNewsSelection('')).toThrow(/пустой ответ/i);
  });

  it('текст без JSON — ошибка', () => {
    expect(() => parseNewsSelection('Извини, не могу помочь')).toThrow(/не нашёл json/i);
  });

  it('ответ без поля picks — ошибка', () => {
    expect(() => parseNewsSelection('{"themes":["trip"]}')).toThrow(/picks/i);
  });

  it('picks не массивом — ошибка', () => {
    expect(() => parseNewsSelection('{"picks":"trip"}')).toThrow(/picks/i);
  });

  it('пункт без headline отбрасывается, годные остаются', () => {
    const out = parseNewsSelection(
      '{"picks":[{"theme":"trip"},{"theme":"profile","headline":"Профиль стал понятнее"}]}',
    );
    expect(out).toEqual([{ theme: 'profile', headline: 'Профиль стал понятнее' }]);
  });

  it('пробельные значения считаются отсутствующими', () => {
    expect(parseNewsSelection('{"picks":[{"theme":"  ","headline":"Что-то"}]}')).toEqual([]);
  });

  it('пробелы вокруг значений срезаются', () => {
    const out = parseNewsSelection('{"picks":[{"theme":" trip ","headline":" Маршрут "}]}');
    expect(out).toEqual([{ theme: 'trip', headline: 'Маршрут' }]);
  });

  it('потолок в две темы здесь не режется — это работа сервиса', () => {
    const picks = [1, 2, 3].map((i) => `{"theme":"t${i}","headline":"h${i}"}`).join(',');
    expect(parseNewsSelection(`{"picks":[${picks}]}`)).toHaveLength(3);
  });
});
