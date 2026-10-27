import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

/**
 * Таблицы роликов — при старте модуля, идемпотентным SQL. Общий
 * `npm run migrate` на проде застрял на base/001 и не докатывает ничего после
 * (tokens-schema.service.ts), поэтому модули катят свои миграции сами.
 */
@Injectable()
export class ShortsSchemaService implements OnModuleInit {
  private readonly logger = new Logger(ShortsSchemaService.name);

  constructor(private readonly pg: PgService) {}

  /** По порядку: 002 и 003 правят таблицы, которые создаёт 001. */
  async onModuleInit() {
    await this.applyMigration('001_shorts.sql');
    await this.applyMigration('002_skits.sql');
    await this.applyMigration('003_youtube.sql');
  }

  /**
   * Два пути, как в tokens-schema.service.ts: рядом с собранным js (dist) и в
   * исходниках. `nest build` .sql в dist не кладёт, так что на проде файл
   * находится по второму. «Не нашёл» — warn, «нашёл и не применил» — error:
   * сломанная миграция не должна прятаться за будничным «skipping».
   */
  private async applyMigration(filename: string) {
    const candidates = [
      path.join(__dirname, 'migrations', filename),
      path.join(__dirname, '..', '..', 'src', 'shorts', 'migrations', filename),
    ];
    let found = false;
    for (const p of [...new Set(candidates)]) {
      if (!fs.existsSync(p)) continue;
      found = true;
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
        this.logger.log(`shorts migration ${filename} applied from ${p}`);
        return;
      } catch (e: any) {
        this.logger.error(`shorts migration ${filename} failed (${p}): ${e.message}`);
      }
    }
    if (found) {
      this.logger.error(`shorts migration ${filename} was found but did not apply on any candidate path`);
    } else {
      this.logger.warn(`shorts migration ${filename} not found, skipping`);
    }
  }
}
