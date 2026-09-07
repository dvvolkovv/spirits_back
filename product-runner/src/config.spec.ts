import { loadConfig } from './config';

const BASE = {
  LINKEON_URL: 'https://test.linkeon.io',
  RUNNER_TOKEN: 'tok',
  CHECKOUT_PATH: '/home/dv/selyanska',
};

describe('loadConfig', () => {
  it('читает обязательные переменные', () => {
    const cfg = loadConfig({ ...BASE } as any);

    expect(cfg.linkeonUrl).toBe('https://test.linkeon.io');
    expect(cfg.runnerToken).toBe('tok');
  });

  it('падает при отсутствии токена, а не стартует вхолостую', () => {
    const env: any = { ...BASE };
    delete env.RUNNER_TOKEN;

    expect(() => loadConfig(env)).toThrow(/RUNNER_TOKEN/);
  });

  it('срезает хвостовой слеш у адреса, чтобы не собрать //webhook', () => {
    const cfg = loadConfig({ ...BASE, LINKEON_URL: 'https://test.linkeon.io/' } as any);

    expect(cfg.linkeonUrl).toBe('https://test.linkeon.io');
  });

  it('без пути к чекауту не стартует', () => {
    // Пустой путь не безобиден: claude -p уедет работать в текущий каталог
    // процесса, то есть агент начнёт править файлы неизвестно где на машине
    // клиента. Отказ на старте дешевле такого хода.
    const env: any = { ...BASE };
    delete env.CHECKOUT_PATH;

    expect(() => loadConfig(env)).toThrow(/CHECKOUT_PATH/);
  });

  it('таймаут хода по умолчанию меньше серверного порога снятия зависших', () => {
    const cfg = loadConfig({ ...BASE } as any);

    // Сервер снимает ход, не подающий признаков жизни, через 30 минут. Если
    // раннер сдаётся позже, ход успеет уехать в failed, и раннер отчитается
    // по уже закрытому ходу — сервер ответит тихим no-op, а работа окажется
    // выполненной и не оплаченной.
    expect(cfg.turnTimeoutMs).toBeLessThan(30 * 60 * 1000);
  });
});
