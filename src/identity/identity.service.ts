import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import type { Provider, ProviderData, Identity, ResolveResult } from './identity.types';

@Injectable()
export class IdentityService implements OnModuleInit {
  private readonly logger = new Logger(IdentityService.name);
  private readonly WELCOME_BONUS = 25000;

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit() {
    if (!this.pg) return;
    const candidates = [
      path.join(__dirname, 'migrations', '001_identity_init.sql'),
      path.join(__dirname, '..', '..', 'src', 'identity', 'migrations', '001_identity_init.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const sql = fs.readFileSync(p, 'utf8');
          await this.pg.query(sql);
          this.logger.log(`identity migration 001 applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`identity migration failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn('identity migration sql not found, skipping');
  }

  // Stubs — заполнятся в Tasks 3 и 4
  async resolveOrCreate<P extends Provider>(_provider: P, _data: ProviderData<P>): Promise<ResolveResult> {
    throw new Error('not implemented');
  }
  async linkMethod<P extends Provider>(_userId: string, _provider: P, _data: ProviderData<P>): Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'invalid' }> {
    throw new Error('not implemented');
  }
  async unlinkMethod(_userId: string, _identityId: string): Promise<{ ok: true } | { ok: false; reason: 'last_method' }> {
    throw new Error('not implemented');
  }
  async listIdentities(_userId: string): Promise<Identity[]> {
    throw new Error('not implemented');
  }
}
