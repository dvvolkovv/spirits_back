import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TurnsService } from './turns.service';

/** Продукт глазами ассистента: без внутренностей, только то, что можно назвать вслух. */
export interface ProductMatch {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  kind: string;
  status: string;
}

@Injectable()
export class ProductToolService {
  private readonly logger = new Logger(ProductToolService.name);

  constructor(
    private readonly pg: PgService,
    private readonly turns: TurnsService,
  ) {}

  /**
   * Нестрогий поиск по имени плюс точные совпадения по слагу, домену и
   * идентификатору: последние три ассистент мог взять из `list` в том же
   * разговоре.
   *
   * Строгий разбор из BlockService.lookup() переиспользовать НЕЛЬЗЯ: он
   * отвечает «не найден» на «магазин цветов» при двух живых магазинах. Там
   * администратор приходит с доменом из жалобы и цена промаха — тихое гашение
   * чужого продукта; здесь цена — уточняющий вопрос.
   *
   * Владелец в WHERE, а не в проверке после выборки: разница между «нет
   * такого» и «есть, но не твой» — утечка существования чужих продуктов.
   */
  async resolve(userId: string, query: string): Promise<ProductMatch[]> {
    const raw = String(query ?? '').trim().toLowerCase();
    if (!raw) return [];
    // '%' и '_' — служебные символы LIKE. Без экранирования «100%» совпадает со
    // всем подряд, и ассистент получает «неоднозначно» там, где совпадение одно.
    const like = `%${raw.replace(/([\\%_])/g, '\\$1')}%`;
    const r = await this.pg.query(
      `SELECT id, name, slug, domain, kind, status
         FROM products
        WHERE user_id = $1 AND archived_at IS NULL
          AND ( id::text = $2
             OR lower(slug) = $2
             OR lower(domain) = $2
             OR lower(name) LIKE $3 )
        ORDER BY created_at DESC`,
      [userId, raw, like],
    );
    return r.rows;
  }
}
