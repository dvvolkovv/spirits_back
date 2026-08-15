import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { ProfileModule } from '../profile/profile.module';
import { CommonModule } from '../common/common.module';
import { BalanceContextService } from './balance-context.service';

@Module({
  imports: [ProfileModule, CommonModule],
  controllers: [TokensController],
  providers: [BalanceContextService],
  exports: [BalanceContextService],
})
export class TokensModule {}
