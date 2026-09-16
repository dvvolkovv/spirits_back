import { SecretsService } from './secrets.service';

// Ключ НЕоднородный: на 'a'.repeat(64) выживала мутация «ключ из первой
// половины hex дважды» — для симметричного ключа она не меняет ничего.
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const PRODUCT = 'prod-42';

/**
 * Мок конфига отвечает ТОЛЬКО на PRODUCT_SECRETS_KEY.
 *
 * Мок вида `{ get: () => KEY }` слеп к имени: переименование переменной в
 * сервисе проходило бы все проверки зелёным, а заведение продукта падало бы уже
 * на проде, где такой переменной нет.
 */
// null означает «переменной в окружении нет». Через undefined это не выразить:
// значение по умолчанию подставилось бы обратно, и проверки на отсутствующий
// ключ молча тестировали бы сервис с ключом.
function make(key: string | null = KEY): SecretsService {
  return new SecretsService({
    get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? (key ?? undefined) : undefined),
  } as any);
}

// Коробка, снятая с рабочей реализации: version(1) | iv(12) | tag(16) | body,
// productId 'prod-42', ключ KEY.
const KNOWN_BOX =
  '018fa1d85e7ad18407d6519d170c1289636eef50c9eb5e583d9924cb4814' +
  'ef61049801fffa26c0b5d26c3c9c0499394dfe3603f0';

describe('SecretsService', () => {
  it('расшифровка возвращает исходное', () => {
    const svc = make();

    const box = svc.encrypt({ BOT_TOKEN: '123:abc' }, PRODUCT);

    expect(svc.decrypt(box, PRODUCT)).toEqual({ BOT_TOKEN: '123:abc' });
  });

  it('коробка, снятая с рабочей реализации, читается и дальше (known-answer)', () => {
    // Единственная проверка, которая переживает СОГЛАСОВАННУЮ правку обеих
    // половин. Проверка суммарной длины пропускала раскладку iv|body|tag,
    // раскладку tag|iv|body и ключ, собранный из первой половины hex дважды, —
    // каждая делает уже лежащие в базе строки нечитаемыми и молчит об этом.
    const svc = make();

    expect(svc.decrypt(Buffer.from(KNOWN_BOX, 'hex'), PRODUCT)).toEqual({ BOT_TOKEN: '123:abc' });
  });

  it('формат коробки закреплён: версия 1, iv 12 байт, тег 16, дальше тело', () => {
    // Правка любой из констант делает все уже лежащие в базе секреты
    // нерасшифровываемыми, и без этой проверки ни один тест не заметит:
    // шифрование и расшифровка поменяются согласованно и роундтрип пройдёт.
    const svc = make();
    const payload = { A: '1' };

    const box = svc.encrypt(payload, PRODUCT);

    expect(box[0]).toBe(1);
    expect(box.length).toBe(1 + 12 + 16 + Buffer.byteLength(JSON.stringify(payload), 'utf8'));
  });

  it('два шифрования одного и того же дают разный шифротекст', () => {
    // Одинаковый шифротекст означал бы фиксированный iv: по базе стало бы
    // видно, у каких продуктов совпадают секреты.
    const svc = make();

    const a = svc.encrypt({ BOT_TOKEN: 'x' }, PRODUCT);
    const b = svc.encrypt({ BOT_TOKEN: 'x' }, PRODUCT);

    expect(a.equals(b)).toBe(false);
  });

  it('ни один байт iv не постоянен от шифрования к шифрованию', () => {
    // Проверка выше ловит только совсем фиксированный iv. Счётчик, обнуляемый
    // при рестарте процесса, даёт разные коробки — и при этом повтор nonce в
    // GCM, то есть разом потерю конфиденциальности и подделываемый тег.
    const svc = make();

    const ivs = Array.from({ length: 200 }, () =>
      svc.encrypt({ BOT_TOKEN: 'x' }, PRODUCT).subarray(1, 13),
    );

    const постоянные = [...Array(12).keys()].filter(
      (pos) => new Set(ivs.map((iv) => iv[pos])).size === 1,
    );
    expect(постоянные).toEqual([]);
  });

  it('подмена шифротекста ловится, а не расшифровывается в мусор', () => {
    // Без проверки тега GCM порча данных дала бы тихий мусор вместо ошибки,
    // и в контейнер уехал бы испорченный токен.
    const svc = make();
    const box = svc.encrypt({ BOT_TOKEN: 'x' }, PRODUCT);
    box[box.length - 1] ^= 0xff;

    expect(() => svc.decrypt(box, PRODUCT)).toThrow();
  });

  it('порча ЛЮБОГО байта коробки ловится — иначе тег не проверяется вовсе', () => {
    // Проверка выше портит ПОСЛЕДНИЙ байт — это закрывающая скобка JSON,
    // поэтому она краснеет и от JSON.parse, без всякой аутентификации.
    // Измерено мутациями: и aes-256-ctr с нулевым тегом, и проглоченный
    // d.final() выживали, оставляя её зелёной. Перебор всех позиций вместо
    // одной — чтобы проверка не зависела от того, где проходят границы.
    const svc = make();

    const len = svc.encrypt({ BOT_TOKEN: 'x' }, PRODUCT).length;
    for (let i = 0; i < len; i++) {
      const box = svc.encrypt({ BOT_TOKEN: 'x' }, PRODUCT);
      box[i] ^= 0xff;
      expect(() => svc.decrypt(box, PRODUCT)).toThrow();
    }
  });

  it('коробка чужого продукта не расшифровывается', () => {
    // Ключ один на все продукты, поэтому без привязки к productId ошибочный
    // WHERE в задаче 3 подтянул бы чужой secrets_encrypted и отдал бы чужой
    // токен в контейнер, ничем не выдав подмену.
    const svc = make();

    const box = svc.encrypt({ BOT_TOKEN: 'x' }, PRODUCT);

    expect(() => svc.decrypt(box, 'prod-43')).toThrow();
  });

  it('пустой productId отвергается: пустой AAD не привязывает ни к чему', () => {
    const svc = make();

    expect(() => svc.encrypt({ A: '1' }, '')).toThrow(/productId/);
  });

  it('коробка чужой версии отвергается внятно', () => {
    // Ротация ключа или смена раскладки без ведущего байта означала бы «всё
    // нечитаемо и отличить старое от нового нечем».
    const svc = make();
    const box = svc.encrypt({ A: '1' }, PRODUCT);
    box[0] = 2;

    expect(() => svc.decrypt(box, PRODUCT)).toThrow(/версия/);
  });

  it('обрезанная коробка отвергается с внятной причиной', () => {
    // Режется РОВНО до длины заголовка: при обрезке до 20 байт зелёной
    // проходила подмена `<=` на `<`, оставлявшая коробку с пустым телом.
    const svc = make();
    const box = svc.encrypt({ A: '1' }, PRODUCT);

    expect(() => svc.decrypt(box.subarray(0, 29), PRODUCT)).toThrow(
      /повреждена или не того формата/,
    );
  });

  it('без ключа в окружении шифрование отказывает громко', () => {
    // Молчаливый переход на «хранить как есть» означал бы секреты открытым
    // текстом в базе, и заметить это было бы нечем.
    const svc = make(null);

    expect(() => svc.encrypt({ A: '1' }, PRODUCT)).toThrow(/PRODUCT_SECRETS_KEY/);
  });

  it('без ключа в окружении расшифровка тоже отказывает громко', () => {
    // Симметрия: проверка только на encrypt пропускала нулевой ключ в decrypt.
    const svc = make(null);

    expect(() => svc.decrypt(Buffer.from(KNOWN_BOX, 'hex'), PRODUCT)).toThrow(
      /PRODUCT_SECRETS_KEY/,
    );
  });

  it('ключ не из hex отвергается, а не умирает на длине ключа', () => {
    // 'z'.repeat(64) проходил счётчик символов и падал сообщением
    // «Invalid key length», из которого причина не читается.
    const svc = make('z'.repeat(64));

    expect(() => svc.encrypt({ A: '1' }, PRODUCT)).toThrow(/PRODUCT_SECRETS_KEY/);
  });

  it('нестроковое значение секрета не выдаётся наружу', () => {
    // Значения поедут переменными окружения контейнера: вложенный объект стал
    // бы там [object Object] без единой жалобы.
    const svc = make();

    const box = svc.encrypt({ A: { b: 'c' } } as any, PRODUCT);

    expect(() => svc.decrypt(box, PRODUCT)).toThrow(/не строка/);
  });

  it('коробка не с объектом внутри отвергается', () => {
    const svc = make();

    const box = svc.encrypt('просто строка' as any, PRODUCT);

    expect(() => svc.decrypt(box, PRODUCT)).toThrow(/не объект/);
  });
});
