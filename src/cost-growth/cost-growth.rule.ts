/**
 * Правило «стоимость растёт с каждым ответом» (спека
 * docs/superpowers/specs/2026-10-14-cost-growth-alert-design.md).
 *
 * 14.10.2026: каждый следующий ответ длинной сессии стоил дороже предыдущего —
 * тарификация брала total_cost_usd всей сессии. Ни «Дорогой ход» (от 30 тыс.
 * за ход), ни «всплеск возвратов» этого не видели. Правило ловит и такую
 * поломку, и честно дорожающую длинную сессию: различить их помогают цифры
 * в алерте.
 */

/** Один ход пары: списано токенов, стоимость в $, расклад расчёта. */
export interface TurnCost {
  tokens: number;
  usd: number;
  note?: string;
  /** Время хода, мс от эпохи. */
  at?: number;
}

export interface CostGrowthConfig {
  /** Сколько последних ходов подряд должны дорожать. */
  turns: number;
  /** Во сколько раз последний из них дороже первого — минимум. */
  factor: number;
  /** Последний ход не дешевле — иначе это дешёвая болтовня. */
  minTokens: number;
}

/**
 * Серия, на которую сработало правило (последние `turns` ходов), или null.
 * История — от старого хода к новому; нулевые ходы в неё не попадают
 * (их не записывает CostGrowthService), поэтому первый ход серии > 0.
 */
export function detectCostGrowth(history: TurnCost[], cfg: CostGrowthConfig): TurnCost[] | null {
  if (history.length < cfg.turns) return null;
  const run = history.slice(-cfg.turns);
  for (let i = 1; i < run.length; i++) {
    if (!(run[i].tokens > run[i - 1].tokens)) return null;
  }
  const first = run[0].tokens;
  const last = run[run.length - 1].tokens;
  if (last < cfg.minTokens) return null;
  if (last < cfg.factor * first) return null;
  return run;
}

const num = (raw: string | undefined, fallback: number, ok: (n: number) => boolean): number => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && ok(n) ? n : fallback;
};

/** Пороги из .env (COST_GROWTH_*); бессмысленные значения — по умолчанию. */
export function costGrowthConfig(env: Record<string, string | undefined> = process.env): CostGrowthConfig & { cooldownH: number } {
  return {
    turns: num(env.COST_GROWTH_TURNS, 5, (n) => Number.isInteger(n) && n >= 2),
    factor: num(env.COST_GROWTH_FACTOR, 3, (n) => n > 1),
    minTokens: num(env.COST_GROWTH_MIN_TOKENS, 1000, (n) => n > 0),
    cooldownH: num(env.COST_GROWTH_COOLDOWN_H, 24, (n) => n > 0),
  };
}
