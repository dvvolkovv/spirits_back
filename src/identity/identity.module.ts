import { Module } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { IdentityService } from './identity.service';
import { PgService } from '../common/services/pg.service';
import { LegacyAuthAccountDeletionAdapter } from './legacy-auth-account-deletion.adapter';

@Module({
  imports: [AccountDeletionModule],
  providers: [IdentityService, PgService, LegacyAuthAccountDeletionAdapter],
  exports: [IdentityService],
})
export class IdentityModule {}
