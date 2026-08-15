import { medianSpend, MIN_SAMPLES, shouldWarn, LOW_BALANCE_THRESHOLD, WARN_COOLDOWN_MS } from './consumption-rate';

describe('medianSpend', () => {
  it('меньше MIN_SAMPLES замеров — null, а не выдуманная цифра', () => {
    expect(medianSpend([100, 200, 300, 400])).toBeNull();
  });

  it('ровно MIN_SAMPLES замеров — уже считаем', () => {
    expect(medianSpend([100, 200, 300, 400, 500])).toBe(300);
  });

  it('нечётное число замеров — средний элемент', () => {
    expect(medianSpend([500, 100, 300, 200, 400])).toBe(300);
  });

  it('чётное число замеров — среднее двух средних', () => {
    expect(medianSpend([100, 200, 300, 400, 500, 600])).toBe(350);
  });

  it('одно дорогое видео не перекашивает прогноз переписки', () => {
    // Пять коротких сообщений и одно видео. Среднее было бы 1758,
    // медиана остаётся в масштабе реальной переписки.
    expect(medianSpend([300, 350, 400, 300, 500, 10000])).toBe(375);
  });

  it('нули и отрицательные отбрасываются, а не занижают медиану', () => {
    // В token_transactions расход лежит отрицательным числом в части строк:
    // знак нормализует вызывающий, сюда должны приходить величины.
    expect(medianSpend([0, -100, 300, 400, 500, 600, 700])).toBe(500);
  });

  it('пустой список — null', () => {
    expect(medianSpend([])).toBeNull();
  });

  it('знаковые суммы расхода из БД дают null — знак обязан нормализовать вызывающий', () => {
    // token_transactions хранит расход отрицательным. Если вызывающий забыл
    // ABS в SQL, прогноз должен пропасть целиком, а не посчитаться по мусору.
    expect(medianSpend([-300, -400, -400, -400, -500])).toBeNull();
  });
});

describe('MIN_SAMPLES', () => {
  it('равен пяти — ниже прогноз недостоверен', () => {
    expect(MIN_SAMPLES).toBe(5);
  });
});

describe('shouldWarn — сервер решает, пора ли предупреждать', () => {
  const now = new Date('2026-08-15T12:00:00Z').getTime();
  const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();

  it('баланс выше порога — не предупреждаем', () => {
    expect(shouldWarn({ balance: 12000, warned: null, now })).toBe(false);
  });

  it('баланс ниже порога, предупреждения не было — предупреждаем', () => {
    expect(shouldWarn({ balance: 8000, warned: null, now })).toBe(true);
  });

  it('ровно на пороге — ещё не предупреждаем', () => {
    expect(shouldWarn({ balance: LOW_BALANCE_THRESHOLD, warned: null, now })).toBe(false);
  });

  it('уже предупреждали час назад — молчим', () => {
    expect(shouldWarn({
      balance: 8000,
      warned: { at: hoursAgo(1), atBalance: 9000 },
      now,
    })).toBe(false);
  });

  it('прошли сутки — предупреждаем снова', () => {
    expect(shouldWarn({
      balance: 8000,
      warned: { at: hoursAgo(25), atBalance: 9000 },
      now,
    })).toBe(true);
  });

  it('баланс вырос относительно прошлого предупреждения — было пополнение, счётчик сброшен', () => {
    // Пользователь пополнил на 5 000, снова потратил до 8 000. Это новый цикл,
    // а не то же самое предупреждение: молчать сутки было бы неправильно.
    expect(shouldWarn({
      balance: 8000,
      warned: { at: hoursAgo(1), atBalance: 3000 },
      now,
    })).toBe(true);
  });

  it('приветственное сообщение — молчим даже при нулевом остатке', () => {
    // Первое, что слышит новый пользователь, не должно быть просьбой заплатить.
    expect(shouldWarn({ balance: 500, warned: null, now, isGreeting: true })).toBe(false);
  });

  it('битая отметка в profile_data не роняет правило и не блокирует предупреждение', () => {
    expect(shouldWarn({
      balance: 8000,
      warned: { at: 'не-дата', atBalance: 9000 } as any,
      now,
    })).toBe(true);
  });
});

describe('константы правила', () => {
  it('порог — 10 000 токенов', () => {
    expect(LOW_BALANCE_THRESHOLD).toBe(10000);
  });

  it('окно молчания — сутки', () => {
    expect(WARN_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });
});
