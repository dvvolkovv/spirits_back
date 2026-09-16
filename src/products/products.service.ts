import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

export interface ProductRow {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  status: string;
  kind: string;
  domain: string | null;
  runner_seen_at: string | null;
  provision_error: string | null;
  created_at: string;
}

// Список колонок перечислен явно и собран ПО КАБИНЕТУ: здесь ровно те поля,
// которые объявлены в `interface Product` фронта (spirits_front
// src/services/productsApi.ts), плюс user_id.
//
// Двух колонок здесь нет по соображениям безопасности: runner_token_hash —
// хеш токена доступа к клиентской VM, secrets_encrypted — шифротекст секретов
// продукта. Эти методы обслуживают клиента, и ни то, ни другое ему не нужно ни
// в каком виде. Заменить перечисление на SELECT * нельзя: обе колонки уедут в
// ответ молча, и следующая секретная колонка тоже. Сторож —
// products.access.spec.ts.
//
// Остальных нет по другой причине — они не секреты, но и не дело кабинета.
// host_ip, checkout_path, build_cmd, restart_cmd, health_url, repo_url и
// claude_session_id описывают, КАК продукт развёрнут на нашей машине: их читают
// агент хоста и раннер внутри контейнера, каждый своим запросом
// (runner.guard.ts перечисляет их отдельно и для себя). В браузере им делать
// нечего — это внутренняя топология, которая через кабинет утекает в консоль,
// в расширения и в снимок вкладки. Ровно тем же приёмом и по той же причине
// собирает ответ create() в products.controller.ts.
//
// kind и provision_error перечислены здесь не для полноты: без них карточка
// отказа в кабинете показывает «сервер не передал причину» при заполненной
// колонке в базе, а бот выглядит сайтом. Колонки завела миграция 002, и
// перечисление — единственное место, которое надо было при этом дописать;
// пропуск ничего не ломает на сервере и потому не виден ни одним его тестом.
// port не перечислен намеренно: это порт на петле хоста, клиенту он не нужен
// и в ответ уходить не должен.
//
// user_id остаётся, хотя фронт его не читает: это id самого спрашивающего
// (WHERE user_id = $1), то есть не утечка, а подтверждение того, чьи продукты
// приехали. На него же опирается сторож формы выборки в products.access.spec.ts.
const COLUMNS = `id, user_id, name, slug, status, kind, domain,
                 runner_seen_at, provision_error, created_at`;

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    await this.applyMigration('001_products.sql');
    // Строго после 001: 002 навешивает колонки на таблицу, которую создаёт 001.
    await this.applyMigration('002_provisioning.sql');
    // 003 ни от кого не зависит (своя таблица, ни одного внешнего ключа), но
    // едет последней: порядок файлов в этом списке — единственное, что
    // описывает порядок схемы, и «независимая» миграция посередине читается
    // как разрешение переставлять.
    await this.applyMigration('003_host_agent.sql');
  }

  async list(userId: string): Promise<ProductRow[]> {
    const r = await this.pg.query(
      `SELECT ${COLUMNS} FROM products
        WHERE user_id = $1 AND archived_at IS NULL
        ORDER BY created_at DESC`,
      [userId],
    );
    return r.rows;
  }

  /**
   * Владелец в WHERE, а не в проверке после выборки. Разница между «нет
   * такого» и «есть, но не твой» — это утечка существования чужих продуктов.
   */
  async getOwned(id: string, userId: string): Promise<ProductRow> {
    const r = await this.pg.query(
      `SELECT ${COLUMNS} FROM products
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [id, userId],
    );
    if (!r.rows[0]) throw new NotFoundException('Product not found');
    return r.rows[0];
  }

  /**
   * Модуль накатывает свою схему сам: общий runner миграций на проде застрял
   * на base/001 и не докатывает ничего после. Тот же приём в custom-agents и
   * tg-bot.
   *
   * ВНИМАНИЕ по порядку кандидатов: в nest-cli.json нет секции assets, поэтому
   * .sql в dist не копируется вообще. На проде существует ВТОРОЙ путь (через
   * src), а не первый. Первый оставлен на случай, если assets когда-нибудь
   * добавят. Не удаляй второй как «dev-фолбэк» — это выключит миграции молча.
   */
  private async applyMigration(filename: string) {
    const candidates = [
      path.join(__dirname, 'migrations', filename),
      path.join(__dirname, '..', '..', 'src', 'products', 'migrations', filename),
    ];
    let found = false;
    for (const p of [...new Set(candidates)]) {
      if (!fs.existsSync(p)) continue;
      found = true;
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
        this.logger.log(`products migration ${filename} applied from ${p}`);
        return;
      } catch (e: any) {
        this.logger.error(`products migration ${filename} failed (${p}): ${e.message}`);
      }
    }
    if (found) {
      this.logger.error(`products migration ${filename} was found but did not apply on any candidate path`);
    } else {
      this.logger.warn(`products migration ${filename} not found, skipping`);
    }
  }
}
