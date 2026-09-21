import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

/**
 * Схема токенов: процедуры, которые двигают баланс.
 *
 * Общий `npm run migrate` на проде застрял на base/001 (падает на
 * `CREATE TYPE payment_status_enum`) и не докатывает НИЧЕГО после — поэтому в
 * этом репозитории модули применяют свои миграции сами, при старте,
 * идемпотентным SQL. Так же сделано в products и payments.
 *
 * Почему модуль tokens, а не payments или base:
 *
 *   - base/001 — снимок схемы прода, а не место для правок: он большой,
 *     катается один раз на пустой базе и на проде не дошёл даже до конца;
 *   - payments владеет ЮKassa, «Приёмом» и купонами, но add_user_tokens зовут
 *     ещё identity (приветственный бонус), auth (правка админом), support (два
 *     возврата), video и smm (по возврату каждый). Ни один из них payments не
 *     импортирует, и вешать общую процедуру на чужой модуль значит сделать
 *     порядок её накатки заложником того, загрузился ли платёжный модуль;
 *   - tokens — модуль самого баланса, здесь же живёт сторож
 *     balance-writes.guard.spec.ts, который требует, чтобы баланс меняли
 *     только эти две процедуры.
 */
@Injectable()
export class TokensSchemaService implements OnModuleInit {
  private readonly logger = new Logger(TokensSchemaService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    await this.applyMigration('001_add_user_tokens_lock.sql');
  }

  /**
   * Два кандидата на путь: рядом с собранным js (dist) и в исходниках — как в
   * products.service.ts. `nest build` кладёт в dist только .ts, .sql туда не
   * попадает без ассетов, и второй путь — единственный, по которому файл
   * находится на проде.
   *
   * Отсутствие файла и падение SQL различаются намеренно: «не нашёл» это
   * warn (dist без исходников), а «нашёл и не применил» — error. Слить их в
   * одну строку значит спрятать сломанную миграцию за буднично выглядящим
   * «skipping».
   */
  private async applyMigration(filename: string) {
    const candidates = [
      path.join(__dirname, 'migrations', filename),
      path.join(__dirname, '..', '..', 'src', 'tokens', 'migrations', filename),
    ];
    let found = false;
    for (const p of [...new Set(candidates)]) {
      if (!fs.existsSync(p)) continue;
      found = true;
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
        this.logger.log(`tokens migration ${filename} applied from ${p}`);
        return;
      } catch (e: any) {
        this.logger.error(`tokens migration ${filename} failed (${p}): ${e.message}`);
      }
    }
    if (found) {
      this.logger.error(
        `tokens migration ${filename} was found but did not apply on any candidate path`,
      );
    } else {
      this.logger.warn(`tokens migration ${filename} not found, skipping`);
    }
  }
}
