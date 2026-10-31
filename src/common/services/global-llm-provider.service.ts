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
  /** Последнее прочитанное из базы: падение базы во время аварии Claude не
   *  должно молча вернуть всех на Claude. */
  private lastKnown: AnswerProvider | null = null;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pg.query(LLM_SETTINGS_DDL);
    } catch (e: any) {
      this.logger.warn(`llm_settings: таблица не создана: ${e?.message}`);
    }
  }

  async get(now: number = Date.now()): Promise<AnswerProvider> {
    if (this.cached && now - this.cached.at < GLOBAL_PROVIDER_CACHE_MS) return this.cached.provider;
    try {
      const r = await this.pg.query('SELECT value FROM llm_settings WHERE key = $1', [GLOBAL_PROVIDER_KEY]);
      const v = r.rows[0]?.value?.provider;
      const provider: AnswerProvider = isAnswerProvider(v) ? v : 'claude';
      this.cached = { provider, at: now };
      this.lastKnown = provider;
      return provider;
    } catch (e: any) {
      this.logger.warn(`llm_settings: рубильник не прочитан: ${e?.message}`);
      return this.lastKnown ?? 'claude';
    }
  }

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

  /** Записывает выбор и сразу обновляет кэш; отдаёт прежнее значение. */
  async set(provider: AnswerProvider, by: string): Promise<{ previous: AnswerProvider }> {
    const before = await this.status();
    await this.pg.query(
      `INSERT INTO llm_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [GLOBAL_PROVIDER_KEY, JSON.stringify({ provider }), by],
    );
    this.cached = { provider, at: Date.now() };
    this.lastKnown = provider;
    return { previous: before.provider };
  }
}
