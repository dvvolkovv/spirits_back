import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    await this.applyMigration('001_products.sql');
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
    for (const p of candidates) {
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
