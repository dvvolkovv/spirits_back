import { TurnsService } from './turns.service';

function makeService(reaped: any[] = []) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: reaped, rowCount: reaped.length };
    }),
  };
  const deductTokens = jest.fn();
  const misc = { deductTokens, checkTokenBalance: jest.fn(async () => ({ ok: true })) };
  return { svc: new TurnsService(pg as any, misc as any), calls, deductTokens };
}

describe('TurnsService.reapStuck', () => {
  it('переводит зависшие running-ходы в failed', async () => {
    const { svc, calls } = makeService([{ id: 't-1' }]);

    await svc.reapStuck();

    const sql = calls[0].sql;
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain('COALESCE(last_progress_at, started_at)');
  });

  it('не трогает ходы, начатые только что', async () => {
    const { svc, calls } = makeService([]);

    // Утверждение на само значение, а не на слово «interval» — оно прошло бы
    // и при '30 seconds', и при '30 days'.
    await svc.reapStuck();

    expect(calls[0].sql).toContain("interval '30 minutes'");
    expect(calls[0].sql).toContain('COALESCE(last_progress_at, started_at)');
  });

  it('не снимает ход, подающий признаки жизни', async () => {
    // Отбор обязан идти по прогрессу, а не по чистой длительности running:
    // легитимно длинный ход (рефакторинг + сборка + тесты) не переживёт
    // порога по одному только started_at, и сборщик снял бы с него замок,
    // пока раннер ещё работает — с тем же чекаутом рядом стартовал бы второй
    // claude -p.
    const { svc, calls } = makeService([]);

    await svc.reapStuck();

    const sql = calls[0].sql;
    // Порог должен быть привязан к COALESCE(last_progress_at, started_at), а
    // не напрямую к started_at — иначе «жив, раз шлёт события» не спасает от
    // снятия по чистому времени в running.
    expect(sql).toMatch(/COALESCE\(last_progress_at,\s*started_at\)\s*<\s*now\(\)/);
  });

  it('зависший ход не тарифицируется', async () => {
    const { svc, deductTokens } = makeService([{ id: 't-1' }]);

    await svc.reapStuck();

    expect(deductTokens).not.toHaveBeenCalled();
  });
});

describe('TurnsService.markProgress', () => {
  it('отмечает свой ход по id и продукту, с условной перезаписью', async () => {
    const { svc, calls } = makeService();

    await svc.markProgress('t-1', 'p-1');

    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toContain('SET last_progress_at = now()');
    expect(sql).toContain('id = $1');
    expect(sql).toContain('product_id = $2');
    // Условие на частоту записи: события идут пачками по несколько раз в
    // секунду, сборщику хватает разрешения в десятки секунд.
    expect(sql).toContain("interval '30 seconds'");
    expect(params).toEqual(['t-1', 'p-1']);
  });
});

describe('TurnsService — жизненный цикл сборщика', () => {
  // Хуки onModuleInit/onModuleDestroy не покрывает ни один другой тест модуля:
  // все спеки создают сервис через `new` и жизненный цикл Nest не поднимают.
  // А сборщик — единственный механизм самовосстановления: без него умерший
  // раннер оставляет ход в running навсегда, и замок держит продукт.
  afterEach(() => jest.useRealTimers());

  it('таймер стартует и вызывает сборщик по интервалу', async () => {
    jest.useFakeTimers();
    const { svc, calls } = makeService([]);

    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(calls.some((c) => c.sql.includes("SET status = 'failed'"))).toBe(true);
  });

  it('таймер не держит процесс', () => {
    jest.useFakeTimers();
    const { svc } = makeService([]);

    svc.onModuleInit();

    // Без unref таймер удерживает event loop: прогон jest не завершается, а
    // остановка приложения подвисает на пять минут.
    expect((svc as any).reaper.hasRef()).toBe(false);
  });

  it('остановка модуля гасит таймер', async () => {
    jest.useFakeTimers();
    const { svc, calls } = makeService([]);

    svc.onModuleInit();
    svc.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(calls).toHaveLength(0);
  });
});
