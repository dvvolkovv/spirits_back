import { TurnsService } from './turns.service';

function makeService(opts: { claim?: any[]; used?: number; alreadyFinal?: boolean } = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  // Возвращает фактически списанное — как настоящий deductTokens, который при
  // нехватке баланса берёт остаток и отдаёт число меньше запрошенного.
  const deductTokens = jest.fn(async (_u: string, amount: number) => opts.used ?? amount);
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SET status = 'running'")) {
        const rows = opts.claim ?? [{ id: 't-1', prompt: 'go', user_id: 'u-1' }];
        return { rows, rowCount: rows.length };
      }
      // Диспетчеризация по `SET status = $3` — намеренно НЕ по литералу
      // `AND status = 'running'`, хотя тот выглядит естественнее. Иначе мок
      // маршрутизировал бы по той же строке, которую охраняет утверждение, и
      // мутация «снять сторож состояния» одновременно снимала бы триггер
      // мок-ветки: запрос начал бы отдавать rowCount 0 всегда, сервис считал
      // бы ход финализированным, и тест на повтор остался бы зелёным именно
      // тогда, когда защита сломана.
      //
      // rowCount = 0 моделирует «ход уже финализирован»: сторож не нашёл
      // строки, и повтор обязан стать no-op.
      if (sql.includes('SET status = $3')) {
        return { rows: [], rowCount: opts.alreadyFinal ? 0 : 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const redis = { rpush: jest.fn(), expire: jest.fn(), lrange: jest.fn(async () => []) };
  return {
    svc: new TurnsService(pg as any, { deductTokens, checkTokenBalance: jest.fn(async () => ({ ok: true })) } as any, redis as any),
    calls,
    deductTokens,
  };
}

const sqlOf = (calls: { sql: string }[]) => calls.map((c) => c.sql).join('\n');

describe('TurnsService.claimNext', () => {
  it('забирает ровно один queued-ход и переводит его в running', async () => {
    const { svc, calls } = makeService();

    const turn = await svc.claimNext('p-1');

    expect(turn).toMatchObject({ id: 't-1' });
    // Отбор — не косметика: без product_id раннер одного продукта заберёт ход
    // чужого и пойдёт править не тот чекаут, а без status='queued' подхватит
    // уже выполняющийся ход.
    expect(sqlOf(calls)).toContain('t.product_id = $1');
    expect(sqlOf(calls)).toContain("t.status = 'queued'");
    // Статус продукта проверяется при выдаче, а не только при постановке:
    // между ними проходит время, и продукт мог уехать в stopped.
    expect(sqlOf(calls)).toContain("p.status = 'running'");
    expect(sqlOf(calls)).toContain('p.archived_at IS NULL');
    expect(sqlOf(calls)).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(sqlOf(calls)).toContain('LIMIT 1');
    // Перевод в running охраняется явно, а не через диспетчер мока: тот
    // маршрутизирует по этой же строке, поэтому покрытие есть, но невидимое —
    // переписав мок на другой предикат, его снимут не заметив.
    expect(sqlOf(calls)).toContain("SET status = 'running'");
    // Самая дорогая из подмен в этом запросе. reapStuck (Task 10) отбирает
    // ходы по `started_at < now() - interval '30 minutes'`; при started_at
    // IS NULL сравнение даёт NULL, строка не отбирается никогда, и мьютекс
    // держит продукт вечно. То есть снятие этой строки молча выключает
    // единственный механизм самовосстановления.
    expect(sqlOf(calls)).toContain('started_at = now()');
    // Task 7 читает prompt и user_id и шлёт их на VM. Мок эти поля выдумывает,
    // поэтому усечение RETURNING без утверждения незаметно. channel сюда не
    // входит: RunnerController его не читает, а неиспользуемое поле рано или
    // поздно начинают поддерживать просто потому, что оно есть.
    expect(sqlOf(calls)).toContain('RETURNING id, prompt, user_id, revert_to_sha');
  });

  it('отдаёт null, когда очередь пуста', async () => {
    const { svc } = makeService({ claim: [] });

    await expect(svc.claimNext('p-1')).resolves.toBeNull();
  });
});

describe('TurnsService.touchRunner', () => {
  it('heartbeat снимает degraded и не трогает остальные статусы', async () => {
    // Без обратного перехода degraded — тупик: мониторинг его ставит, никто
    // не снимает, и продукт навсегда остаётся «нет связи» и без работы.
    const { svc, calls } = makeService();

    await svc.touchRunner('p-1');

    expect(calls[0].sql).toContain('runner_seen_at = now()');
    // Два узких утверждения вместо одного точного сравнения всего выражения:
    // то было бы привязано к форматированию — перенос строки или лишний
    // пробел ронял бы тест, ничего не сломав. Здесь два разных обещания:
    // срабатывает только на degraded, и всё остальное сохраняется как было.
    expect(calls[0].sql).toContain("WHEN status = 'degraded'");
    expect(calls[0].sql).toContain('ELSE status END');
    // Условная запись — иначе два десятка записей в минуту на продукт.
    expect(calls[0].sql).toContain("interval '30 seconds'");
    expect(calls[0].sql).toContain('WHERE id = $1');
    expect(calls[0].params).toEqual(['p-1']);
  });
});

describe('TurnsService.complete', () => {
  it('успешный ход списывает токены', async () => {
    const { svc, calls, deductTokens } = makeService();

    await svc.complete('t-1', {
      productId: 'p-1',
      userId: 'u-1',
      status: 'done',
      result: 'готово',
      shaBefore: 'aaa',
      shaAfter: 'bbb',
      tokens: 1200,
    });

    expect(deductTokens).toHaveBeenCalledWith('u-1', 1200, expect.stringContaining('product'));

    // Без утверждения о WHERE подмена `id = $1` на `id = $2` проходит мимо
    // всех тестов: мок игнорирует текст, а проверяется только вызов
    // deductTokens, который от этого не зависит. Последствие — исход хода
    // записывается не в ту строку либо никуда, ход остаётся running, и замок
    // держит продукт до сборщика через полчаса.
    expect(calls[0].sql).toContain('WHERE id = $1');
    // COALESCE хранит уже записанный sha_before, когда раннер его не прислал.
    // Без него откат теряет точку возврата, а кнопка «вернуть как было»
    // перестаёт работать на ходах, доложенных без shaBefore.
    expect(calls[0].sql).toContain('COALESCE($6, sha_before)');
    expect(calls[0].sql).toContain('tokens_spent = $8');
    expect(calls[0].sql).toContain('result = $4, error = $5');
    expect(calls[0].sql).toContain('finished_at = now()');
    // Сторож состояния — то, что делает повтор безвредным.
    expect(calls[0].sql).toContain("AND status = 'running'");
  });

  it('ход чужого продукта не завершается', async () => {
    // RunnerGuard подтверждает, каким продуктом является раннер, но не то, что
    // переданный в URL turnId принадлежит этому продукту. Без product_id в
    // WHERE раннер продукта A завершил бы ход продукта B и списал бы за него
    // с владельца A.
    const { svc, calls } = makeService();

    await svc.complete('t-1', { productId: 'p-1', userId: 'u-1', status: 'done', tokens: 100 });

    expect(calls[0].sql).toContain('product_id = $2');
    expect(calls[0].params[1]).toBe('p-1');
  });

  it('повторный complete не списывает второй раз', async () => {
    // Маршрут завершения идёт с клиентской VM через интернет: таймаут чтения
    // ответа при доставленном запросе штатен, и раннер обязан ретраить. Без
    // сторожа состояния пользователь платит дважды за один ход.
    const { svc, deductTokens } = makeService({ alreadyFinal: true });

    await svc.complete('t-1', { productId: 'p-1', userId: 'u-1', status: 'done', tokens: 1200 });

    expect(deductTokens).not.toHaveBeenCalled();
  });

  it('в историю пишется фактически списанное, а не запрошенное', async () => {
    // deductTokens при нехватке баланса берёт остаток и возвращает меньше
    // запрошенного. Если писать в tokens_spent число из тела раннера, кабинет
    // покажет пользователю расход, которого с него не взяли.
    const { svc, calls } = makeService({ used: 300 });

    await svc.complete('t-1', { productId: 'p-1', userId: 'u-1', status: 'done', tokens: 1200 });

    const fix = calls.find((c) => c.sql.includes('SET tokens_spent = $2'));
    expect(fix).toBeDefined();
    expect(fix!.params).toEqual(['t-1', 300]);
  });

  it('отрицательные токены от раннера не уходят в базу', async () => {
    const { svc, calls, deductTokens } = makeService();

    await svc.complete('t-1', { productId: 'p-1', userId: 'u-1', status: 'done', tokens: -5 });

    // Кламп существует потому, что тело запроса раннера — TS-тип при
    // ValidationPipe({whitelist:false}), то есть рантайм-проверки нет вовсе.
    // Без клампа сюда прилетает 23514 от CHECK (tokens_spent >= 0), уходит
    // наружу необработанным 500, ход остаётся running и держит замок.
    expect(calls[0].params[7]).toBe(0);
    expect(deductTokens).not.toHaveBeenCalled();
  });

  it('упавший ход не тарифицируется', async () => {
    const { svc, deductTokens } = makeService();

    await svc.complete('t-1', { productId: 'p-1', userId: 'u-1', status: 'failed', error: 'claude exited 1', tokens: 900 });

    expect(deductTokens).not.toHaveBeenCalled();
  });

  it('откат по health-check не тарифицируется', async () => {
    const { svc, deductTokens } = makeService();

    await svc.complete('t-1', { productId: 'p-1', userId: 'u-1', status: 'reverted', shaBefore: 'aaa', tokens: 900 });

    expect(deductTokens).not.toHaveBeenCalled();
  });
});
