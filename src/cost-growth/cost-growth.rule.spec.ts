import { costGrowthConfig, detectCostGrowth, type TurnCost } from './cost-growth.rule';

// 14.10.2026: пороги по умолчанию сменились на 5 ходов / ×1,2 / 8 000 токенов —
// решение владельца по итогам прогона правила на 30 днях реальных ходов.
const CFG = { turns: 5, factor: 1.2, minTokens: 8000 };
const turns = (...tokens: number[]): TurnCost[] => tokens.map((t) => ({ tokens: t, usd: t / 3600 }));

describe('правило «стоимость растёт с каждым ответом»', () => {
  it('реальная серия жалобы 14.10 — рост ×1,34 на высоком уровне, ×3 её пропускал', () => {
    const run = detectCostGrowth(turns(11867, 12221, 15478, 15724, 15924), CFG);
    expect(run?.map((t) => t.tokens)).toEqual([11867, 12221, 15478, 15724, 15924]);
  });
  it('смотрит на последние пять: более ранние ходы не мешают', () => {
    expect(detectCostGrowth(turns(50000, 100, 11867, 12221, 15478, 15724, 15924), CFG)).not.toBeNull();
  });
  it('провал посередине — тишина', () => {
    expect(detectCostGrowth(turns(8500, 9000, 8800, 15724, 15924), CFG)).toBeNull();
  });
  it('равный соседу ход — не «дороже»', () => {
    expect(detectCostGrowth(turns(8500, 9000, 9000, 15724, 15924), CFG)).toBeNull();
  });
  it('рост меньше ×1,2 — тишина (дорого, но не разгон)', () => {
    expect(detectCostGrowth(turns(9000, 9100, 9200, 9300, 9400), CFG)).toBeNull();
  });
  it('последний дешевле 8 000 — тишина (дешёвая болтовня)', () => {
    expect(detectCostGrowth(turns(1000, 2000, 3000, 4000, 7000), CFG)).toBeNull();
  });
  it('ходов меньше пяти — тишина', () => {
    expect(detectCostGrowth(turns(8500, 9200, 9600, 10000), CFG)).toBeNull();
  });
});

describe('пороги из окружения', () => {
  it('по умолчанию — 5 ходов, ×1,2, 8 000 токенов, пауза 24 часа', () => {
    expect(costGrowthConfig({})).toEqual({ turns: 5, factor: 1.2, minTokens: 8000, cooldownH: 24 });
  });
  it('берёт числа из .env', () => {
    expect(
      costGrowthConfig({ COST_GROWTH_TURNS: '7', COST_GROWTH_FACTOR: '5', COST_GROWTH_MIN_TOKENS: '2000', COST_GROWTH_COOLDOWN_H: '12' }),
    ).toEqual({ turns: 7, factor: 5, minTokens: 2000, cooldownH: 12 });
  });
  it('мусор и бессмысленные значения — по умолчанию', () => {
    expect(costGrowthConfig({ COST_GROWTH_TURNS: '1', COST_GROWTH_FACTOR: 'abc', COST_GROWTH_MIN_TOKENS: '-5', COST_GROWTH_COOLDOWN_H: '0' })).toEqual({
      turns: 5, factor: 1.2, minTokens: 8000, cooldownH: 24,
    });
  });
  it('COST_GROWTH_TURNS выше хранимой истории (>10) — тоже по умолчанию: иначе правило молчало бы всегда', () => {
    expect(costGrowthConfig({ COST_GROWTH_TURNS: '11' })).toEqual({ turns: 5, factor: 1.2, minTokens: 8000, cooldownH: 24 });
  });
});
