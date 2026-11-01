import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from './pg.service';
import { ANSWER_PROVIDERS, AnswerProvider, ProviderChoice, isAnswerProvider } from './llm-fallback';
import { GlobalLlmProviderService } from './global-llm-provider.service';

/** Модель ответов: 'claude', 'qwen' или 'kimi'. */
export type LlmProvider = AnswerProvider;
export const LLM_PROVIDERS: readonly LlmProvider[] = ANSWER_PROVIDERS;

/** Личный выбор в карточке: 'default' — «Как у всех» (NULL в базе), иначе модель. */
export type LlmChoice = 'default' | AnswerProvider;
export const LLM_CHOICES: readonly LlmChoice[] = ['default', ...ANSWER_PROVIDERS];

export function isLlmChoice(v: unknown): v is LlmChoice {
  return v === 'default' || isAnswerProvider(v);
}

/** Чем отвечать человеку: модель и чей это выбор (null — проба, выбора нет). */
export interface AnswerRoute {
  provider: AnswerProvider;
  choice: ProviderChoice | null;
}

/**
 * Модель ответов ассистентов для конкретного человека (spec
 * 2026-10-30-llm-provider-switch, 2026-10-31-global-llm-switch).
 * NULL — «Как у всех» (общий рубильник), 'claude' / 'qwen' / 'kimi' — явный
 * личный выбор, рубильник к нему не применяется.
 *
 * Отдельная колонка, а не ключ profile_data: profile_data пишет сам
 * пользователь через обновление профиля, а этот выбор тратит квоту владельца —
 * его меняет только админка.
 */
@Injectable()
export class UserLlmProviderService implements OnModuleInit {
  private readonly logger = new Logger(UserLlmProviderService.name);

  constructor(
    private readonly pg: PgService,
    // Без @Optional(): рубильник веб-чата не должен молча остаться на Claude,
    // если граф DI не нашёл GlobalLlmProviderService. Без декоратора Nest
    // считает зависимость обязательной и валит старт при поломке графа —
    // поймает smoke на test, а не тишина на проде (spec
    // 2026-10-31-global-llm-switch). TS-опциональность (?) сохранена ради
    // юнит-тестов: они создают сервис через `new` без второго аргумента, как
    // pg? у ClaudeCliService. Сторож типа — design:paramtypes в
    // user-llm-provider.service.spec.ts.
    private readonly globalProvider?: GlobalLlmProviderService,
  ) {}

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

  /** Личный выбор; NULL, мусор, нет пользователя и сбой БД — «Как у всех». */
  async get(userId: string): Promise<LlmChoice> {
    if (!userId) return 'default';
    try {
      const r = await this.pg.query('SELECT llm_provider FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
      const v = r.rows[0]?.llm_provider;
      return isAnswerProvider(v) ? v : 'default';
    } catch (e: any) {
      this.logger.warn(`llm_provider: не прочитан для ${userId}: ${e?.message}`);
      return 'default';
    }
  }

  /**
   * false — такого пользователя нет. 'default' и незнакомое значение пишутся
   * как NULL («Как у всех») — колонку не засоряет мусором ни один вызывающий.
   */
  async set(userId: string, choice: LlmChoice): Promise<boolean> {
    const value = isAnswerProvider(choice) ? choice : null;
    const r = await this.pg.query(
      'UPDATE ai_profiles_consolidated SET llm_provider = $2 WHERE user_id = $1',
      [userId, value],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Чем отвечать человеку: личный выбор, иначе общий рубильник.
   *
   * globalProvider.get() не бросает по контракту (см. его JSDoc), но вызов
   * здесь — вторая линия защиты сверх этого контракта: вызывающий в
   * chat.service.ts стоит ВНЕ try, уже после снятия in-flight метки дедупа,
   * и необработанное исключение тут заблокировало бы повтор того же
   * сообщения пользователем на 10 минут. При сбое — Claude.
   */
  async route(userId: string): Promise<{ provider: AnswerProvider; choice: ProviderChoice }> {
    const mine = await this.get(userId);
    if (mine !== 'default') return { provider: mine, choice: 'user' };
    let provider: AnswerProvider = 'claude';
    if (this.globalProvider) {
      try {
        provider = await this.globalProvider.get();
      } catch (e: any) {
        this.logger.warn(`рубильник не прочитан, ответ Claude: ${e?.message}`);
      }
    }
    return { provider, choice: 'global' };
  }
}
