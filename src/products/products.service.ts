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
  host_ip: string | null;
  domain: string | null;
  repo_url: string | null;
  checkout_path: string;
  build_cmd: string | null;
  restart_cmd: string | null;
  health_url: string | null;
  runner_seen_at: string | null;
  claude_session_id: string | null;
  provision_error: string | null;
  created_at: string;
}

// Список колонок перечислен явно, и двух из них здесь нет намеренно:
// runner_token_hash — хеш токена доступа к клиентской VM, secrets_encrypted —
// шифротекст секретов продукта. Эти методы обслуживают клиента, и ни то, ни
// другое ему не нужно ни в каком виде. Заменить перечисление на SELECT *
// нельзя: обе колонки уедут в ответ молча, и следующая секретная колонка тоже.
// Сторож — products.access.spec.ts.
// kind и provision_error перечислены здесь не для полноты: без них карточка
// отказа в кабинете показывает «сервер не передал причину» при заполненной
// колонке в базе, а бот выглядит сайтом. Колонки завела миграция 002, и
// перечисление — единственное место, которое надо было при этом дописать;
// пропуск ничего не ломает на сервере и потому не виден ни одним его тестом.
// port не перечислен намеренно: это порт на петле хоста, клиенту он не нужен
// и в ответ уходить не должен.
const COLUMNS = `id, user_id, name, slug, status, kind, host_ip, domain, repo_url,
                 checkout_path, build_cmd, restart_cmd, health_url,
                 runner_seen_at, claude_session_id, provision_error, created_at`;

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    await this.applyMigration('001_products.sql');
    // Строго после 001: 002 навешивает колонки на таблицу, которую создаёт 001.
    await this.applyMigration('002_provisioning.sql');
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
