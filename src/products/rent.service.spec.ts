import { RENT_TOKENS, RentService } from './rent.service';

/**
 * ФОРМА ЗАПРОСА СПИСАНИЯ. Поведение — в provisioning.integration.spec.ts:
 * двойное списание, частичный расход и гонка с ходом на заглушках
 * ненаблюдаемы, мок отдаёт что ему сказали при любом SQL.
 *
 * Здесь сторожатся ровно те свойства, которые видны в тексте запроса и в
 * возвращаемом значении, и каждое из них — уже случившаяся или измеренная
 * беда, а не вкус:
 *
 *   - ОДИН оператор. Два — это окно, в которое второй процесс кластера
 *     (прод работает в двух) спишет второй раз;
 *   - достаток баланса читается ПОД ЗАМКОМ. Измерено на живой базе: без
 *     `FOR UPDATE` в подзапросе ход, списавший токены за правку в тот же миг,
 *     оставляет владельца с нулём вместо 40 000 и с месяцем, за который взяли
 *     10 000, — то есть ровно тот частичный расход, от которого уходили;
 *   - `GREATEST(0, …)` в списании запрещён: он превращает недостачу в тихий
 *     частичный расход;
 *   - правда о списании берётся из ЧИСЛА СПИСАНИЙ, а не из rowCount: ответ
 *     этого оператора — одна строка со счётчиками всегда, и rowCount у него
 *     равен единице даже когда не списалось ничего.
 */

type Row = { claimed: string; charged: string; logged: string };

function makeService(rows: Row[] = [{ claimed: '1', charged: '1', logged: '1' }]) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      // Счётчики приезжают из count(*), то есть bigint, то есть СТРОКАМИ:
      // node-pg не приводит bigint к числу, и сравнение вида `row.charged > 0`
      // держится на приведении типов в JS, а не на коде.
      return { rows, rowCount: rows.length };
    }),
  };
  const svc = new RentService(pg as any);
  const log = {
    error: jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined),
    warn: jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined),
  };
  return { svc, calls, pg, log };
}

describe('RentService.chargeRent — форма запроса', () => {
  afterEach(() => jest.restoreAllMocks());

  it('списание и сдвиг периода идут ОДНИМ оператором', async () => {
    // Два запроса вместо одного — это окно, в которое второй процесс кластера
    // спишет второй раз. Точка сериализации — блокировка строки продукта
    // внутри одного оператора, и разбитый на два запроса замок живёт в
    // rowCount между ними, то есть не живёт.
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    expect(calls).toHaveLength(1);
  });

  it('период занимается предусловием «срок истёк», а не безусловно', async () => {
    // Сдвиг без предусловия — это второй месяц, оплаченный один раз.
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    expect(calls[0].sql).toContain('paid_until <= now()');
  });

  it('платят только работающие: спящий и архивный не платят', async () => {
    // Спящий не копит долг — решение владельца, и держится оно ровно на этом
    // условии. degraded здесь наравне с running: контейнер запущен, сайт
    // отвечает, машина занята; потеря связи с ассистентом — наша поломка, а не
    // основание не платить. На проде 16.09.2026 четыре продукта из шести
    // именно в degraded.
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    expect(calls[0].sql).toContain("status IN ('running','degraded')");
    expect(calls[0].sql).toContain('archived_at IS NULL');
  });

  it('достаток баланса проверяется В УСЛОВИИ занятия периода и ПОД ЗАМКОМ', async () => {
    // Две разные вещи в одном месте, обе обязательные.
    //
    // «В условии» — иначе период уедет вперёд, а денег не возьмут: бесплатный
    // месяц. «Под замком» — иначе баланс прочитан по снимку начала оператора,
    // и параллельное списание за правку уводит его вниз уже после проверки.
    // Измерено на живой базе (PostgreSQL 16): без FOR UPDATE при балансе
    // 60 000 и ходе, забравшем 20 000, аренда оставляла ноль и засчитывала
    // месяц; с FOR UPDATE — оператор ждёт 714 мс, перечитывает 40 000 и не
    // делает ничего.
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    const cond = calls[0].sql.match(/EXISTS \([^)]*ai_profiles_consolidated[\s\S]*?\)/);
    expect(cond).not.toBeNull();
    expect(cond![0]).toContain('tokens >= $2');
    expect(cond![0]).toContain('FOR UPDATE');
  });

  it('само списание ещё раз сверяет достаток', async () => {
    // Пояс поверх подтяжек: если замок когда-нибудь перестанет браться (смена
    // версии, перепланирование запроса), это условие превращает «ушли в минус»
    // в «не списали ничего» — расхождение, которое видно и в логе, и в
    // возвращаемом значении.
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    const hits = calls[0].sql.match(/tokens >= \$2/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('частичного списания нет ни в каком виде', async () => {
    // `misc.deductTokens` (через consume_user_tokens) при нехватке забирает
    // СКОЛЬКО ЕСТЬ. Для правки это верно — работа сделана. Для аренды это
    // худший исход: денег взяли не сколько надо, продукт всё равно заснёт, а
    // баланс обнулён. `GREATEST(0, …)` в списании — та же беда своими руками.
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    expect(calls[0].sql).not.toContain('consume_user_tokens');
    expect(calls[0].sql).not.toMatch(/GREATEST\s*\(\s*0/);
  });

  it('цена аренды уезжает параметром, и она одна на весь код', async () => {
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    expect(RENT_TOKENS).toBe(50_000);
    expect(calls[0].params).toEqual(['p-1', RENT_TOKENS]);
    // Число, вшитое в текст запроса, разъедется с константой молча.
    expect(calls[0].sql).not.toContain('50000');
  });

  it('списание попадает в учёт токенов тем же оператором', async () => {
    // Спека: отдельной таблицы расходов не заводим, аренда ложится в
    // существующий учёт рядом с правками. Иначе владелец видит, как исчезли
    // 50 000, и не может узнать за что: на 2026-08-08 в token_transactions уже
    // лежало 29 840 списаний и ноль начислений — ровно эта беда, но с другой
    // стороны. Знак минус и тип 'consumed' — как у consume_user_tokens:
    // админские отчёты берут ABS(SUM(amount)) по 'consumed'.
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    expect(calls[0].sql).toContain('INSERT INTO token_transactions');
    expect(calls[0].sql).toContain("'consumed'");
    expect(calls[0].sql).toContain('balance_after');
    expect(calls[0].sql).toMatch(/-\s*\(?\$2/);
  });

  it('месяц отсчитывается от занятого срока, а не от календаря', async () => {
    // Заведённый 31-го иначе платил бы за один день.
    const { svc, calls } = makeService();

    await svc.chargeRent('p-1');

    expect(calls[0].sql).toContain("interval '1 month'");
    expect(calls[0].sql).toContain('paid_until + ');
  });

  it('правда о списании берётся из числа списаний, а не из числа строк ответа', async () => {
    // Оператор отдаёт ОДНУ строку со счётчиками при любом исходе, и rowCount у
    // него равен единице даже когда не списалось ничего. Реализация на
    // rowCount отвечала бы «списал» всегда — и сборщик никогда бы никого не
    // усыплял.
    const { svc } = makeService([{ claimed: '0', charged: '0', logged: '0' }]);

    expect(await svc.chargeRent('p-1')).toBe(false);
  });

  it('списалось — значит true', async () => {
    const { svc } = makeService([{ claimed: '1', charged: '1', logged: '1' }]);

    expect(await svc.chargeRent('p-1')).toBe(true);
  });

  it('«период занят, а денег не взяли» не проходит молча', async () => {
    // Расхождение счётчиков означает бесплатный месяц. Случиться оно может
    // только если замок не сработал, поэтому строка в логе тут важнее самого
    // числа: без неё бесплатный хостинг виден лишь по недосчитанной выручке.
    const { svc, log } = makeService([{ claimed: '1', charged: '0', logged: '0' }]);

    expect(await svc.chargeRent('p-1')).toBe(false);

    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/аренд/i));
  });

  it('упавшая база — это исключение, а не «не списалось»', async () => {
    // Сборщик усыпляет продукт ровно по ответу false. Проглоченная ошибка базы
    // усыпила бы ВСЕ продукты разом на одном моргании соединения, и каждому
    // потребовалось бы пробуждение вручную.
    const { svc, pg } = makeService();
    pg.query.mockRejectedValueOnce(new Error('база моргнула') as never);

    await expect(svc.chargeRent('p-1')).rejects.toThrow('база моргнула');
  });
});
