import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { PgService } from '../common/services/pg.service';

@Module({
  providers: [IdentityService, PgService],
  exports: [IdentityService],
})
export class IdentityModule {}
