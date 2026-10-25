import { deidentify, maskDigits, maskEmails, maskNames, maskUrls } from './deidentify';

describe('обезличивание', () => {
  it.each(['+7 (903) 016-91-87', '8-903-016-91-87', '79030169187', '+44 20 7946 0958'])('телефон %s', (phone) => {
    expect(maskDigits(`звоните ${phone} вечером`)).toBe('звоните [телефон] вечером');
  });

  it('номер карты и длинный номер — [число]', () => {
    expect(maskDigits('карта 4276 1234 5678 9012')).toBe('карта [число]');
    expect(maskDigits('заказ 1234567')).toBe('заказ [число]');
  });

  it('короткие числа остаются', () => {
    expect(maskDigits('149 ₽ в 10:30, 2 раза')).toBe('149 ₽ в 10:30, 2 раза');
  });

  it('цифры через перевод строки не склеиваются', () => {
    expect(maskDigits('шаг 1\n2 3')).toBe('шаг 1\n2 3');
  });

  it('почта', () => {
    expect(maskEmails('пишите на v.ivanov@yandex.ru, спасибо')).toBe('пишите на [почта], спасибо');
  });

  it('у локальной части длиннее 64 знаков (RFC 5321) метка закрывает последние 64 и домен', () => {
    expect(maskEmails(`${'a'.repeat(70)}@mail.ru`)).toBe('aaaaaa[почта]');
  });

  it('длинное слово без пробелов — за линейное время, а не за квадрат', () => {
    const t = Date.now();
    deidentify(['ж'.repeat(12_000), 'a.'.repeat(6_000), '1-'.repeat(6_000), 'x@'.repeat(6_000)].join(' '), ['Владимир']);
    // Квадратичная регулярка тратила на 12 000 знаков около двух секунд.
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('ссылка на известную площадку — только её домен, без пути', () => {
    expect(maskUrls('канал https://t.me/sportrodkom?start=abc')).toBe('канал [ссылка: t.me]');
    expect(maskUrls('см. www.ozon.ru/seller/123')).toBe('см. [ссылка: ozon.ru]');
    expect(maskUrls('https://seller.ozon.ru/app/products')).toBe('[ссылка: ozon.ru]');
  });

  it('ссылка на свой сайт — без домена: домен называет человека или его дело', () => {
    expect(maskUrls('мой магазин https://teselectro.ru/catalog')).toBe('мой магазин [ссылка]');
    expect(maskUrls('портфолио www.ivanova-design.com')).toBe('портфолио [ссылка]');
  });

  it('адрес без http и www тоже ловится, а файлы и «т.е.» — нет', () => {
    expect(maskUrls('мой сайт teselectro.ru/catalog, загляните')).toBe('мой сайт [ссылка], загляните');
    expect(maskUrls('ищу на ozon.ru')).toBe('ищу на [ссылка: ozon.ru]');
    expect(maskUrls('пришлю отчёт.pdf и код на Node.js, т.е. завтра')).toBe('пришлю отчёт.pdf и код на Node.js, т.е. завтра');
  });

  it('почта не распадается на имя и домен', () => {
    expect(deidentify('пишите ivanova@mail.ru')).toBe('пишите [почта]');
  });

  it('имя в падежах, а похожие слова не трогаются', () => {
    const s = 'Владимир, это для Владимира. Передайте Владимиру. Владение — другое.';
    expect(maskNames(s, ['Владимир'])).toBe('[имя], это для [имя]. Передайте [имя]. Владение — другое.');
  });

  it('женское имя с основой без гласной', () => {
    expect(maskNames('Анна и Анну', ['Анна'])).toBe('[имя] и [имя]');
  });

  it('короткие имена не маскируются — слишком много ложных', () => {
    expect(maskNames('Ян пришёл', ['Ян'])).toBe('Ян пришёл');
  });

  it('всё вместе и в правильном порядке', () => {
    const out = deidentify('Я Иванова, почта ivanova@mail.ru, тел 8 903 016 91 87, сайт https://ivanova.ru/a', ['Иванова']);
    expect(out).toBe('Я [имя], почта [почта], тел [телефон], сайт [ссылка]');
  });
});
