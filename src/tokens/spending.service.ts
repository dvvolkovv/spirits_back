import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { spendCategorySql, type SpendCategory } from './spend-category';

/**
 * Сводка расхода по месяцам для GET /webhook/tokens/spending.
 *
 * Только consumed-строки журнала: пополнения, возвраты и корректировки
 * остаются в истории пополнений, поэтому баланс = пополнения − расход.
 */
export interface SpendingCategoryRow {
  key: SpendCategory;
  tokens: number;
  count: number;
}

export interface SpendingMonthRow {
  month: string;
  total: number;
  categories: SpendingCategoryRow[];
}

/** Пояс по умолчанию: без него ответ в 02:11 по Москве 1-го числа уехал бы в прошлый месяц. */
export const DEFAULT_SPENDING_TZ = 'Europe/Moscow';
export const DEFAULT_MONTHS = 12;
export const MAX_MONTHS = 24;

export function clampMonths(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MONTHS;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MONTHS;
  return Math.min(MAX_MONTHS, Math.max(1, n));
}

interface RawRow {
  month: string;
  category: string;
  tokens: string | number;
  count: string | number;
}

export function groupMonths(rows: RawRow[], limit: number): SpendingMonthRow[] {
  const byMonth = new Map<string, SpendingCategoryRow[]>();
  for (const r of rows) {
    const tokens = Number(r.tokens) || 0;
    if (tokens <= 0) continue;
    const list = byMonth.get(r.month) ?? [];
    list.push({ key: r.category as SpendCategory, tokens, count: Number(r.count) || 0 });
    byMonth.set(r.month, list);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, limit)
    .map(([month, categories]) => ({
      month,
      total: categories.reduce((sum, c) => sum + c.tokens, 0),
      categories: categories.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key)),
    }));
}

@Injectable()
export class SpendingService {
  private readonly logger = new Logger(SpendingService.name);
  /** Имена из pg_timezone_names. Читаются один раз: представление каждый раз обходит базу поясов. */
  private zones: Set<string> | null = null;

  constructor(private readonly pg: PgService) {}

  /**
   * Пояс пользователя или Москва. Неизвестный пояс — не ошибка: у старого
   * браузера блок иначе молча пропал бы.
   */
  async resolveTz(tz: unknown): Promise<string> {
    if (typeof tz !== 'string' || !tz) return DEFAULT_SPENDING_TZ;
    try {
      if (!this.zones) {
        const r = await this.pg.query('SELECT name FROM pg_timezone_names');
        this.zones = new Set(r.rows.map((x: any) => String(x.name)));
      }
    } catch (e: any) {
      this.logger.warn(`список часовых поясов не прочитан: ${e?.message}`);
      return DEFAULT_SPENDING_TZ;
    }
    return this.zones.has(tz) ? tz : DEFAULT_SPENDING_TZ;
  }

  async monthly(userId: string, tz?: unknown, months?: unknown): Promise<SpendingMonthRow[]> {
    const zone = await this.resolveTz(tz);
    const res = await this.pg.query(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE $2), 'YYYY-MM') AS month,
              ${spendCategorySql()} AS category,
              SUM(ABS(amount))::bigint AS tokens,
              COUNT(*)::int AS count
         FROM token_transactions
        WHERE user_id = $1 AND transaction_type = 'consumed'
        GROUP BY 1, 2`,
      [userId, zone],
    );
    return groupMonths(res.rows as RawRow[], clampMonths(months));
  }
}
