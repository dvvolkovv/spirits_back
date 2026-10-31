import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from './pg.service';
import { ANSWER_PROVIDERS, AnswerProvider, isAnswerProvider } from './llm-fallback';

/** Модель ответов человека: 'claude' (по умолчанию), 'qwen' или 'kimi'. */
export type LlmProvider = AnswerProvider;
export const LLM_PROVIDERS: readonly LlmProvider[] = ANSWER_PROVIDERS;

/**
 * Модель ответов ассистентов для конкретного человека (spec
 * docs/superpowers/specs/2026-10-30-llm-provider-switch-design.md).
 * NULL — Claude (по умолчанию), 'qwen' или 'kimi' — ответы сразу через
 * выбранного (spec 2026-10-30-llm-provider-switch, 2026-10-31-kimi-provider-design).
 *
 * Отдельная колонка, а не ключ profile_data: profile_data пишет сам
 * пользователь через обновление профиля, а этот выбор тратит квоту владельца —
 * его меняет только админка.
 */
@Injectable()
export class UserLlmProviderService implements OnModuleInit {
  private readonly logger = new Logger(UserLlmProviderService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    try {
      // ALTER TABLE ... ADD COLUMN берёт ACCESS EXCLUSIVE lock на всю таблицу,
      // даже с IF NOT EXISTS, — проверяем через information_schema сначала:
      // когда колонка уже есть (обычный случай после первого запуска), лок
      // не берётся вовсе. Без значения по умолчанию и без индекса сам ALTER
      // (когда он всё же нужен) — мгновенный.
      const exists = await this.pg.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_profiles_consolidated' AND column_name = 'llm_provider'",
      );
      if (exists.rows.length > 0) return;
      await this.pg.query('ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS llm_provider text');
    } catch (e: any) {
      this.logger.warn(`llm_provider: колонка не добавлена: ${e?.message}`);
    }
  }

  /** Сбой БД — Claude: ход не должен падать из-за настройки. */
  async get(userId: string): Promise<LlmProvider> {
    if (!userId) return 'claude';
    try {
      const r = await this.pg.query('SELECT llm_provider FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
      const v = r.rows[0]?.llm_provider;
      // NULL и незнакомое значение — Claude.
      return isAnswerProvider(v) ? v : 'claude';
    } catch (e: any) {
      this.logger.warn(`llm_provider: не прочитан для ${userId}: ${e?.message}`);
      return 'claude';
    }
  }

  /** false — такого пользователя нет. */
  async set(userId: string, provider: LlmProvider): Promise<boolean> {
    const r = await this.pg.query(
      'UPDATE ai_profiles_consolidated SET llm_provider = $2 WHERE user_id = $1',
      [userId, provider === 'claude' ? null : provider],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
