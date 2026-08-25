import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import {
  BUSINESS_FIELDS,
  BusinessFieldKey,
  BusinessProfile,
  FieldSource,
  isBusinessProfileEmpty,
  renderBusinessBlock,
} from './business-profile.types';
import { shouldSkipBusinessExtraction } from './extract-prefilter';

const FIELD_BY_KEY = new Map(BUSINESS_FIELDS.map(f => [f.key as string, f]));

@Injectable()
export class BusinessProfileService {
  private readonly logger = new Logger(BusinessProfileService.name);

  constructor(
    @Optional() private readonly pg?: PgService,
    @Optional() private readonly claudeCli?: ClaudeCliService,
  ) {}

  async read(userId: string): Promise<BusinessProfile> {
    if (!this.pg) return {};
    const res = await this.pg.query(
      `SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    return (res.rows[0]?.profile_data?.business as BusinessProfile) || {};
  }

  /** Ключи полей, которые ещё не заполнены. */
  async missingFields(userId: string): Promise<BusinessFieldKey[]> {
    const p = await this.read(userId);
    return BUSINESS_FIELDS
      .filter(f => !(p[f.key]?.value || '').trim())
      .map(f => f.key);
  }

  /**
   * Слить входящие значения в карточку.
   *
   * Правило не-затирания: при source='assistant' поля с source='user' не
   * трогаются. Без него автосбор постепенно съедает то, что человек
   * выверил руками, и карточка деградирует ниже уровня «вообще без
   * автосбора» — неверный tax_mode тихо отравляет ответы бухгалтера.
   */
  async merge(
    userId: string,
    incoming: Partial<Record<BusinessFieldKey, string>>,
    source: FieldSource,
  ): Promise<BusinessProfile> {
    if (!this.pg) return {};
    const current = await this.read(userId);
    const next: BusinessProfile = { ...current };
    const now = new Date().toISOString();
    let changed = false;

    for (const [rawKey, rawValue] of Object.entries(incoming || {})) {
      const spec = FIELD_BY_KEY.get(rawKey);
      if (!spec) continue;

      const value = String(rawValue ?? '').trim();
      if (!value) continue;

      // Мусор от модели в enum-поле отбрасываем: лучше пусто, чем ложь,
      // которую потом читает бухгалтер.
      if (spec.enum && !spec.enum.includes(value)) continue;

      const existing = next[spec.key];
      if (existing?.source === 'user' && source === 'assistant') continue;
      if (existing?.value === value && existing?.source === source) continue;

      next[spec.key] = { value, source, updated_at: now };
      changed = true;
    }

    if (!changed) return current;

    const res = await this.pg.query(
      `UPDATE ai_profiles_consolidated
          SET profile_data = jsonb_set(
                COALESCE(profile_data, '{}'::jsonb), '{business}', $1::jsonb, true),
              updated_at = now()
        WHERE user_id = $2`,
      [JSON.stringify(next), userId],
    );

    // rowCount === 0 значит: строки профиля для этого userId нет (например,
    // пользователь ещё не создан identity.service — сюда не наше дело её
    // заводить, это привело бы к сиротам). Врать вызывающему, что карточка
    // сохранена, хуже, чем просто не сохранить: фича существует, чтобы
    // ассистент помнил бизнес пользователя, и тихая потеря записи — самый
    // незаметный из возможных отказов.
    if (!res.rowCount) {
      this.logger.warn(`merge: UPDATE не задел ни одной строки — нет профиля для user_id=${userId}`);
      return current;
    }

    return next;
  }

  async isEmpty(userId: string): Promise<boolean> {
    return isBusinessProfileEmpty(await this.read(userId));
  }

  /** Прочитать карточку и отрендерить блок для промпта. Вся логика формата —
   *  в чистой renderBusinessBlock; здесь только чтение. */
  async renderForPrompt(userId: string, category: string | null | undefined): Promise<string> {
    return renderBusinessBlock(await this.read(userId), category);
  }

  /**
   * Достать факты о бизнесе из одного хода разговора.
   *
   * Отдельный LLM-вызов, а не расширение TasksService.extractFromTurn:
   * у извлечения задач нет ни одного теста и нет golden-набора, так что
   * просадку его качества от подселения второй задачи никто бы не заметил.
   *
   * Вызывать в setImmediate после ответа. Никогда не бросает наружу:
   * ход пользователя не должен падать из-за необязательной памяти.
   */
  async extractFromTurn(
    userId: string,
    agentId: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    if (!this.pg || !this.claudeCli) return;
    if (shouldSkipBusinessExtraction(userMessage)) return;

    try {
      const missing = await this.missingFields(userId);
      if (missing.length === 0) return;

      const raw = await this.claudeCli.text(this.buildExtractPrompt(missing, userMessage, assistantMessage));
      const parsed = this.parseJson(raw);
      const fields = parsed?.fields;
      if (!fields || typeof fields !== 'object') return;

      await this.merge(userId, fields, 'assistant');
    } catch (e: any) {
      this.logger.warn(`business extractFromTurn failed for ${userId}/${agentId}: ${e?.message}`);
    }
  }

  private buildExtractPrompt(missing: BusinessFieldKey[], userMessage: string, assistantMessage: string): string {
    const specs = BUSINESS_FIELDS
      .filter(f => missing.includes(f.key))
      .map(f => f.enum
        ? `- ${f.key}: одно из ${f.enum.join(' | ')}`
        : `- ${f.key}: короткая строка, словами пользователя`)
      .join('\n');

    return `Ты ведёшь карточку бизнеса пользователя платформы my.linkeon.io.

Прочитай один ход разговора и вытащи только те факты о ЕГО СОБСТВЕННОМ бизнесе, которые он сообщил прямо.

НЕЗАПОЛНЕННЫЕ ПОЛЯ (только их и заполняй):
${specs}

РЕПЛИКА ПОЛЬЗОВАТЕЛЯ:
"""
${userMessage.slice(0, 3000)}
"""

ОТВЕТ АССИСТЕНТА:
"""
${assistantMessage.slice(0, 3000)}
"""

ПРАВИЛА:
- Только то, что пользователь сказал о себе. Не додумывай, не выводи по косвенным признакам, не бери из слов ассистента.
- Гипотеза — это не факт. Сомневаешься — не заполняй. Пустой ответ лучше выдуманного.
- Для полей со списком значений верни РОВНО один код из списка. Не подходит ни один — поле пропусти.
- Чужой бизнес, работодатель, планы «когда-нибудь открою» — не считаются.

Верни ТОЛЬКО валидный JSON, без markdown-обёрток и без прозы:
{"fields": {"ключ": "значение"}}

Нечего извлечь — верни {"fields": {}}`;
  }

  /** Толерантный парсер: модель периодически заворачивает JSON в ```json. */
  private parseJson(raw: string): any | null {
    if (!raw) return null;
    const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
