import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { inTransaction } from '../blog/blog-slot-claim';
import { PgService } from '../common/services/pg.service';

const MIGRATION_FILENAME = '001_account_deletion.sql';

@Injectable()
export class AccountDeletionSchemaService implements OnModuleInit {
  private readonly logger = new Logger(AccountDeletionSchemaService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    const candidates = [
      path.join(__dirname, 'migrations', MIGRATION_FILENAME),
      path.join(__dirname, '..', '..', 'src', 'account-deletion', 'migrations', MIGRATION_FILENAME),
    ];
    const migrationPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!migrationPath) {
      throw new Error(`account deletion migration ${MIGRATION_FILENAME} not found`);
    }

    const sql = fs.readFileSync(migrationPath, 'utf8');
    await inTransaction(this.pg, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(1947433921)');
      await tx.query("SET LOCAL lock_timeout='5s'");
      await tx.query(sql);
    });
    this.logger.log(`account deletion migration applied from ${migrationPath}`);
  }
}
