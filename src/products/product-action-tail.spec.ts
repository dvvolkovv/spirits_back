import { productActionTail, stripProductActionBlocks } from './product-action-tail';

const A = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const B = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' };

describe('хвост ответа с карточками', () => {
  // BACKEND_URL влияет на ссылку в ветке "без карточек" (см. productActionTail
  // ниже) — сохраняем/восстанавливаем по образцу products-relay-fields.spec.ts.
  const OLD_BASE = process.env.BACKEND_URL;
  afterEach(() => {
    if (OLD_BASE === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = OLD_BASE;
  });
  afterAll(() => {
    if (OLD_BASE === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = OLD_BASE;
  });

  it('клиент с карточками — блок product-action с одним id', () => {
    expect(productActionTail([A], true, 'ru')).toBe('\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```');
  });

  it('клиент без карточек — ссылка на кабинет на языке собеседника', () => {
    const t = productActionTail([A], false, 'de');
    expect(t).toBe('\n\nBestätige es in deinem Konto: https://my.linkeon.io/studio?tab=products&action=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('нет карточек — пусто', () => {
    expect(productActionTail([], true, 'ru')).toBe('');
  });

  it('несколько действий в одном ходе — блок на каждое', () => {
    const t = productActionTail([A, B], true, 'ru');
    expect(t).toBe(
      '\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```' +
      '\n\n```product-action\n{"id":"bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"}\n```',
    );
  });

  it('несколько действий без карточек — ссылка на каждое', () => {
    const t = productActionTail([A, B], false, 'ru');
    expect(t).toBe(
      '\n\nПодтвердите в кабинете: https://my.linkeon.io/studio?tab=products&action=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' +
      '\n\nПодтвердите в кабинете: https://my.linkeon.io/studio?tab=products&action=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    );
  });

  it('незнакомый язык — откат на ru', () => {
    const t = productActionTail([A], false, 'xx-not-a-real-lang');
    expect(t).toBe('\n\nПодтвердите в кабинете: https://my.linkeon.io/studio?tab=products&action=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('BACKEND_URL с хвостовым слешем — не задваивается', () => {
    process.env.BACKEND_URL = 'https://test.linkeon.io/';
    const t = productActionTail([A], false, 'ru');
    expect(t).toBe('\n\nПодтвердите в кабинете: https://test.linkeon.io/studio?tab=products&action=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });
});

/**
 * Модель не имеет права сама писать блок product-action: она видит старые
 * блоки в истории разговора и знает actionId из результата своего же
 * инструмента — и может скопировать чужой/просроченный блок или повторить
 * свежий второй раз. Эта функция вырезает такой блок ДО того, как сервер
 * допишет свой (или не допишет вовсе, если действий в этом ходе не было).
 */
describe('stripProductActionBlocks', () => {
  it('один блок — вырезается целиком, вместе с пустыми строками перед ним', () => {
    const text = 'Готово, сайт создан.\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```\n\nЧто дальше?';
    expect(stripProductActionBlocks(text)).toBe('Готово, сайт создан.\n\nЧто дальше?');
  });

  it('два блока в одном тексте — вырезаются оба, разрыв между абзацами не задваивается', () => {
    const text =
      'Первое.\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```' +
      '\n\nВторое.\n\n```product-action\n{"id":"bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"}\n```' +
      '\n\nТретье.';
    expect(stripProductActionBlocks(text)).toBe('Первое.\n\nВторое.\n\nТретье.');
  });

  it('блок внутри текста (не последним) — убирается без следа', () => {
    const text = 'До.\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```\n\nПосле.';
    expect(stripProductActionBlocks(text)).toBe('До.\n\nПосле.');
  });

  it('обычный ```js-фенс не трогается', () => {
    const text = 'Вот код:\n\n```js\nconst x = 1;\n```\n\nГотово.';
    expect(stripProductActionBlocks(text)).toBe(text);
  });

  it('незакрытый блок — режется до конца текста (стрим мог обрезать закрывающую ```)', () => {
    const text = 'Готово.\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeee';
    expect(stripProductActionBlocks(text)).toBe('Готово.');
  });

  it('без блока — текст не трогается', () => {
    const text = 'Обычный ответ без карточек.';
    expect(stripProductActionBlocks(text)).toBe(text);
  });

  it('пустая строка — пустая строка', () => {
    expect(stripProductActionBlocks('')).toBe('');
  });

  // Баг: модель иногда закрывает блок без переноса строки перед `` ``` `` —
  // сразу за JSON («}```»). Ленивое тело regexp-а, которое искало ПЕРВУЮ
  // закрывающую строку именно в виде "\n```", в этом случае не находило её
  // вовсе и съедало весь остаток ответа до конца текста. Тело блока — JSON,
  // в нём бэктиков не бывает, поэтому границей блока обязана быть ЛЮБАЯ
  // первая встреченная `` ``` ``.
  it('закрывающая fence сразу за JSON без переноса строки ("}```") — хвост после блока цел', () => {
    const text = 'Т\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}```\nпосле';
    expect(stripProductActionBlocks(text)).toBe('Т\nпосле');
  });

  it('закрывающая fence с отступом — вырезается вместе с блоком', () => {
    const text = 'До.\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n  ```\nПосле.';
    expect(stripProductActionBlocks(text)).toBe('До.\nПосле.');
  });

  it('открывающая fence с пробелом перед именем ("``` product-action") — тоже блок, вырезается', () => {
    const text = 'До.\n\n``` product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```\nПосле.';
    expect(stripProductActionBlocks(text)).toBe('До.\nПосле.');
  });

  it('имя блока в другом регистре ("PRODUCT-ACTION") — тоже блок, вырезается', () => {
    const text = 'До.\n\n```PRODUCT-ACTION\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```\nПосле.';
    expect(stripProductActionBlocks(text)).toBe('До.\nПосле.');
  });
});
