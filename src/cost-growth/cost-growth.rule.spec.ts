import { costGrowthConfig, detectCostGrowth, type TurnCost } from './cost-growth.rule';

const CFG = { turns: 5, factor: 3, minTokens: 1000 };
const turns = (...tokens: number[]): TurnCost[] => tokens.map((t) => ({ tokens: t, usd: t / 3600 }));

describe('правило «стоимость растёт с каждым ответом»', () => {
  it('пять ходов подряд дороже, последний ×3 и от 1 000 — срабатывает', () => {
    const run = detectCostGrowth(turns(420, 610, 980, 1650, 2900), CFG);
    expect(run?.map((t) => t.tokens)).toEqual([420, 610, 980, 1650, 2900]);
  });
  it('смотрит на последние пять: более ранние ходы не мешают', () => {
    expect(detectCostGrowth(turns(5000, 100, 420, 610, 980, 1650, 2900), CFG)).not.toBeNull();
  });
  it('провал посередине — тишина', () => {
    expect(detectCostGrowth(turns(420, 610, 500, 1650, 2900), CFG)).toBeNull();
  });
  it('равный соседу ход — не «дороже»', () => {
    expect(detectCostGrowth(turns(420, 610, 610, 1650, 2900), CFG)).toBeNull();
  });
  it('рост меньше ×3 — тишина (длинные ответы, но не разгон)', () => {
    expect(detectCostGrowth(turns(1000, 1200, 1500, 2000, 2900), CFG)).toBeNull();
  });
  it('последний дешевле 1 000 — тишина (дешёвая болтовня)', () => {
    expect(detectCostGrowth(turns(100, 150, 300, 600, 900), CFG)).toBeNull();
  });
  it('ходов меньше пяти — тишина', () => {
    expect(detectCostGrowth(turns(420, 980, 1650, 2900), CFG)).toBeNull();
  });
  it('жалоба 14.10: разгон стоимости сессии ловится на пятом ходе', () => {
    // Списывали total_cost_usd всей сессии: каждый ход — сумма предыдущих.
    const usd = [0.16, 0.33, 0.52, 0.74, 0.97];
    const history = usd.map((u) => ({ tokens: Math.ceil(u * 3600), usd: u }));
    expect(detectCostGrowth(history, CFG)).not.toBeNull();
  });
});

describe('пороги из окружения', () => {
  it('по умолчанию — 5 ходов, ×3, 1 000 токенов, пауза 24 часа', () => {
    expect(costGrowthConfig({})).toEqual({ turns: 5, factor: 3, minTokens: 1000, cooldownH: 24 });
  });
  it('берёт числа из .env', () => {
    expect(
      costGrowthConfig({ COST_GROWTH_TURNS: '7', COST_GROWTH_FACTOR: '5', COST_GROWTH_MIN_TOKENS: '2000', COST_GROWTH_COOLDOWN_H: '12' }),
    ).toEqual({ turns: 7, factor: 5, minTokens: 2000, cooldownH: 12 });
  });
  it('мусор и бессмысленные значения — по умолчанию', () => {
    expect(costGrowthConfig({ COST_GROWTH_TURNS: '1', COST_GROWTH_FACTOR: 'abc', COST_GROWTH_MIN_TOKENS: '-5', COST_GROWTH_COOLDOWN_H: '0' })).toEqual({
      turns: 5, factor: 3, minTokens: 1000, cooldownH: 24,
    });
  });
});
