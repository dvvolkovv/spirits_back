import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { DEFAULT_MAX_PRODUCTS, LimitsService } from './limits.service';

/**
 * ФОРМА ЗАПРОСА И РАЗБОР ОТВЕТА. Поведение предела против живой базы стоит в
 * provisioning.integration.spec.ts, сценарии 87–95: COALESCE умолчания, отбор
 * по владельцу и по archived_at, само сравнение — всё это исполняет Postgres, и
 * заглушка ниже их не проверяет вовсе.
 *
 * Здесь проверяется ровно то, чего живая база не видит: сколько запросов ушло,
 * что именно подставлено параметром, как читается ответ и что показывается
 * человеку.
 *
 * ЗАГЛУШКА ОТВЕЧАЕТ ПО ЗАДАННОЙ СТРОКЕ, А НЕ ОДНО И ТО ЖЕ НА ЛЮБОЙ ВХОД.
 * Постоянный ответ сделал бы половину сценариев зелёными при реализации,
 * которая выдачу не читает совсем.
 */
const make = (rows: any[]) => {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    }),
  };
  return { svc: new LimitsService(pg as any), pg, calls };
};

/** Строка, какой её отдаёт база: used — СТРОКА (bigint), allowed — число (int4). */
const row = (used: string, allowed: number, over: boolean) => [{ used, allowed, over }];

describe('LimitsService.assertCanCreate', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('место есть — молчит и ходит в базу РОВНО ОДИН раз', async () => {
    // Один запрос — не экономия, а требование: предел и счёт обязаны приехать
    // из ОДНОГО снимка. Двумя запросами между ними помещается чужой коммит, и
    // отказ выписывался бы по числам из разных моментов.
    const { svc, pg } = make(row('1', 2, false));

    await expect(svc.assertCanCreate('u-1', false)).resolves.toBeUndefined();

    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('умолчание уезжает ПАРАМЕТРОМ, а не числом внутри запроса', async () => {
    // Число, вписанное в текст SQL, — вторая копия умолчания. Копии расходятся:
    // правка константы не доехала бы до запроса, и предел остался бы прежним
    // молча.
    const { svc, calls } = make(row('0', 2, false));

    await svc.assertCanCreate('u-42', false);

    expect(calls[0].params).toEqual(['u-42', DEFAULT_MAX_PRODUCTS]);
    expect(calls[0].sql).toMatch(/COALESCE\([\s\S]*\$2/);
  });

  it('запрос отбирает по владельцу, мимо архивных, и сравнивает В SQL', async () => {
    // Форма, а не исполнение: живую проверку каждого из трёх держат сценарии
    // 88, 91 и 92. Здесь сторожится ровно то, что сравнение не уехало в
    // JavaScript — там типы разъезжаются (bigint строкой, int4 числом), и
    // сторожа у этой щели быть не может.
    const { svc, calls } = make(row('0', 2, false));

    await svc.assertCanCreate('u-1', false);

    expect(calls[0].sql).toContain('p.user_id = $1');
    expect(calls[0].sql).toContain('p.archived_at IS NULL');
    expect(calls[0].sql).toContain('l.user_id = $1');
    expect(calls[0].sql).toMatch(/m\.used\s*>=\s*c\.allowed/);
  });

  it('решение принимает БАЗА: числам в выдаче реализация не пересчитывает', async () => {
    // Числа нарочно противоречат флагу. Реализация, считающая `used >= allowed`
    // сама, отбила бы заведение — и тем вернула бы себе всю разницу типов,
    // ради ухода от которой сравнение и переехало в SQL.
    const { svc } = make(row('10', 2, false));

    await expect(svc.assertCanCreate('u-1', false)).resolves.toBeUndefined();
  });

  it('флаг true отбивает даже при нулевом счёте', async () => {
    const { svc } = make(row('0', 9, true));

    await expect(svc.assertCanCreate('u-1', false)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('пустая выдача и потерянный алиас ЗАПИРАЮТ заведение, а не открывают его', async () => {
    // Чтение файл-закрытое: отказ ставится на всё, что не равно явному false.
    // Мягкое `if (over === true)` открыло бы предел настежь и молча — ровно тем
    // способом, которым в этом каталоге уже терялся product_id в RETURNING.
    // Сломанный предел обязан запирать заведение.
    for (const rows of [[], [{}], [{ used: '5', allowed: 2 }]]) {
      const { svc } = make(rows);
      await expect(svc.assertCanCreate('u-1', false)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    }
  });

  it('администратора не спрашивают у базы вовсе', async () => {
    // Не «спросили и не посмотрели»: запрос на каждое заведение админа был бы
    // и лишним походом, и местом, где однажды появится ветка «а вот этому
    // админу всё-таки нельзя».
    const { svc, pg } = make(row('99', 2, true));

    await expect(svc.assertCanCreate('u-адм', true)).resolves.toBeUndefined();

    expect(pg.query).not.toHaveBeenCalled();
  });

  it('признак администратора сверяется строго: строка «false» админом не делает', async () => {
    // `isAdmin` доезжает сюда из req.user, то есть без единой проверки типа.
    // Приведение к истинности сделало бы администратором любую непустую строку.
    const { svc, pg } = make(row('2', 2, true));

    await expect(svc.assertCanCreate('u-1', 'false' as any)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('отказ — 422, и это код, в котором кабинет показывает НАШ текст', async () => {
    // 409 кабинет разбирает как «адрес занят» и текст сервера игнорирует, всё
    // `>= 500` глушит своей формулировкой. Измерено в куске 4а.
    const { svc } = make(row('2', 2, true));

    const e = await svc.assertCanCreate('u-1', false).catch((x) => x);

    expect(e.getStatus()).toBe(422);
  });

  it('текст называет предел и ДЕЙСТВИЕ, которое существует', async () => {
    // «Попробуйте позже» здесь неправда: само не пройдёт никогда. «Заархивируйте
    // ненужный» — тоже: архивации у продукта нет ни кнопки, ни маршрута, ни
    // строки кода (products.archived_at не пишет никто). Совет сделать
    // недоступное человек читает как отказ без причины.
    const { svc } = make(row('2', 2, true));

    const e = await svc.assertCanCreate('u-1', false).catch((x) => x);

    expect(String(e.message)).toContain('Предел — 2 продукта на один аккаунт');
    expect(String(e.message)).toMatch(/напишите нам/i);
    expect(String(e.message)).not.toMatch(/позже|архив/i);
  });

  it('число в отказе берётся из ВЫДАЧИ, а не из константы', async () => {
    const { svc } = make(row('5', 5, true));

    const e = await svc.assertCanCreate('u-щедрый', false).catch((x) => x);

    expect(String(e.message)).toContain('Предел — 5 продуктов');
  });

  it('склонение считается по правилу русского счёта, а не «один против остальных»', async () => {
    // 11–14 — «продуктов», хотя остаток от десяти единица и двойка. Лесенка
    // `n === 1 ? 'продукт' : 'продукта'` дала бы «11 продукта» и «5 продукта».
    const forms: [number, string][] = [
      [1, '1 продукт '],
      [2, '2 продукта '],
      [4, '4 продукта '],
      [5, '5 продуктов '],
      [11, '11 продуктов '],
      [14, '14 продуктов '],
      [21, '21 продукт '],
      [22, '22 продукта '],
    ];
    for (const [n, expected] of forms) {
      const { svc } = make(row(String(n), n, true));
      const e = await svc.assertCanCreate('u-1', false).catch((x) => x);
      expect(String(e.message)).toContain(`Предел — ${expected}`);
    }
  });

  it('сломанная выдача не показывает человеку NaN', async () => {
    // Состояние уже сломанное — но текст отказа обязан оставаться читаемым:
    // «Предел — NaN продуктов» человек перешлёт нам скриншотом, а понять из
    // него нельзя ничего.
    const { svc } = make([{}]);

    const e = await svc.assertCanCreate('u-1', false).catch((x) => x);

    expect(String(e.message)).not.toMatch(/NaN|undefined/);
    expect(String(e.message)).toContain(`Предел — ${DEFAULT_MAX_PRODUCTS} `);
  });

  it('отказ оставляет строку в журнале: иначе о задетом пределе не узнает никто', async () => {
    // Общего списка продуктов у администратора нет, а триггер пересмотра в
    // спеке — «первая жалоба либо первый случай, когда это заметят». Журнал —
    // единственное место, где это видно до жалобы.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc } = make(row('2', 2, true));

    await svc.assertCanCreate('u-шумный', false).catch(() => undefined);

    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/u-шумный.*2.*2/);
  });

  it('удачная проверка журнал не засоряет', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc } = make(row('0', 2, false));

    await svc.assertCanCreate('u-1', false);

    expect(warn).not.toHaveBeenCalled();
  });
});
