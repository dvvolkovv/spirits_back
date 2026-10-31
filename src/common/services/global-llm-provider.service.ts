import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from './pg.service';
import { AnswerProvider, isAnswerProvider } from './llm-fallback';

/** Ключ строки рубильника в llm_settings. */
export const GLOBAL_PROVIDER_KEY = 'global_provider';
/** Сколько живёт прочитанное значение: API — один процесс pm2, переключение
 *  действует не позже чем через это время, без выката и рестарта. */
export const GLOBAL_PROVIDER_CACHE_MS = 15_000;

/**
 * Таблица настроек модели ответов. Катится при КАЖДОМ старте API, поэтому —
 * один DO под advisory-локом (одновременные старты не сталкиваются), как
 * guest-trial/migrations/001_guest_trial.sql. CREATE TABLE IF NOT EXISTS на
 * готовой таблице — бесплатный no-op.
 *
 * Откат: DROP TABLE llm_settings — но только после того, как
 * GlobalLlmProviderService убран из CommonModule, иначе следующий старт API
 * создаст таблицу заново.
 *
 * Будущим миграциям (002 и далее): не добавлять колонку прямо здесь через
 * ALTER TABLE ... ADD COLUMN IF NOT EXISTS — он берёт ACCESS EXCLUSIVE lock на
 * всю таблицу при КАЖДОМ старте API, даже когда колонка уже есть, а
 * llm_settings читается на каждом вызове CLI (ClaudeCliService) — конкурентные
 * чтения встанут на время лока. Добавлять такую колонку — проверкой каталога
 * (information_schema.columns) перед ALTER, внутри того же DO.
 */
export const LLM_SETTINGS_DDL = `DO $llm_settings$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('llm-settings/001'));
  PERFORM set_config('lock_timeout', '5s', true);
  CREATE TABLE IF NOT EXISTS llm_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );
END
$llm_settings$`;

export interface GlobalProviderStatus {
  provider: AnswerProvider;
  /** Когда переключили (ISO); null — ни разу. */
  since: string | null;
  /** Кто переключил — userId админа. */
  by: string | null;
}

/**
 * Общий рубильник модели ответов (spec 2026-10-31-global-llm-switch, раздел 2):
 * модель для всех, у кого в карточке «Как у всех», для гостей пробы и для
 * фоновых задач. Нет строки или мусор — Claude.
 */
@Injectable()
export class GlobalLlmProviderService implements OnModuleInit {
  private readonly logger = new Logger(GlobalLlmProviderService.name);
  private cached: { provider: AnswerProvider; at: number } | null = null;
  /** Поколение записи: get() кладёт прочитанное (или запасное при сбое) в
   *  кэш только если за время чтения не случилось параллельной set() —
   *  иначе медленный запрос, начатый ДО записи и разрешившийся ПОСЛЕ неё,
   *  затёр бы её своим более старым значением (перенесено из
   *  guest-trial/guest-trial-store.service.ts). */
  private generation = 0;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pg.query(LLM_SETTINGS_DDL);
    } catch (e: any) {
      // error, не warn: без этой таблицы рубильник не работает вовсе —
      // get()/set() будут падать или молча стоять на Claude для всех.
      this.logger.error(`llm_settings: таблица не создана: ${e?.message}`);
    }
  }

  /** Не бросает: сбой базы — последнее известное значение или Claude.
   *  UserLlmProviderService.route() держит свой try/catch вокруг этого вызова
   *  как вторую линию защиты, но прежде всего полагается на этот контракт —
   *  нарушать его нельзя. */
  async get(now: number = Date.now()): Promise<AnswerProvider> {
    const c = this.cached;
    if (c && now >= c.at && now - c.at < GLOBAL_PROVIDER_CACHE_MS) return c.provider;
    const genAtStart = this.generation;
    try {
      const r = await this.pg.query('SELECT value FROM llm_settings WHERE key = $1', [GLOBAL_PROVIDER_KEY]);
      const v = r.rows[0]?.value?.provider;
      const provider: AnswerProvider = isAnswerProvider(v) ? v : 'claude';
      if (this.generation === genAtStart) this.cached = { provider, at: now };
      return provider;
    } catch (e: any) {
      this.logger.warn(`llm_settings: рубильник не прочитан: ${e?.message}`);
      // Запасное — последнее закэшированное, а не всегда 'claude': авария
      // базы во время аварии самого Claude не должна молча вернуть всех на
      // Claude. Кладём его в кэш (с той же проверкой поколения), чтобы при
      // лежащей базе не ходить в пул и не писать warn чаще раза в
      // GLOBAL_PROVIDER_CACHE_MS.
      const fallback = this.cached?.provider ?? 'claude';
      if (this.generation === genAtStart) this.cached = { provider: fallback, at: now };
      return fallback;
    }
  }

  /**
   * Бросает при сбое базы — не подставляет Claude молча: вызывающий (блок
   * «Модель ответов для всех» в админке, плашка на вкладках, суточное
   * напоминание) должен показать «не удалось прочитать», а не ошибочно
   * убедить, что рубильник стоит на Claude, когда это на самом деле неизвестно.
   */
  async status(): Promise<GlobalProviderStatus> {
    const r = await this.pg.query(
      'SELECT value, updated_at, updated_by FROM llm_settings WHERE key = $1',
      [GLOBAL_PROVIDER_KEY],
    );
    const row = r.rows[0];
    const v = row?.value?.provider;
    return {
      provider: isAnswerProvider(v) ? v : 'claude',
      since: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      by: row?.updated_by ?? null,
    };
  }

  /**
   * Записывает выбор и сразу обновляет кэш; отдаёт прежнее значение.
   *
   * Прежнее значение читается ОТДЕЛЬНЫМ запросом до записи: при двух
   * одновременных переключениях «было» в сообщении админу может оказаться
   * неточным (оба читают один и тот же момент «до») — для текста алерта это
   * приемлемо, линеаризация здесь не нужна.
   */
  async set(provider: AnswerProvider, by: string, now: number = Date.now()): Promise<{ previous: AnswerProvider }> {
    if (!isAnswerProvider(provider)) throw new Error(`llm_settings: недопустимая модель ${String(provider)}`);
    const before = await this.status();
    await this.pg.query(
      `INSERT INTO llm_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [GLOBAL_PROVIDER_KEY, JSON.stringify({ provider }), by],
    );
    this.generation++;
    this.cached = { provider, at: now };
    return { previous: before.provider };
  }
}
