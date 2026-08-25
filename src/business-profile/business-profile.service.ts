import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import {
  BUSINESS_FIELDS,
  BusinessFieldKey,
  BusinessProfile,
  FieldSource,
  isBusinessProfileEmpty,
  renderBusinessBlock,
} from './business-profile.types';

const FIELD_BY_KEY = new Map(BUSINESS_FIELDS.map(f => [f.key as string, f]));

@Injectable()
export class BusinessProfileService {
  private readonly logger = new Logger(BusinessProfileService.name);

  constructor(@Optional() private readonly pg?: PgService) {}

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
}
