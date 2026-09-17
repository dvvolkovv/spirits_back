import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { ProfileModule } from '../profile/profile.module';
import { CommonModule } from '../common/common.module';
import { BalanceContextService } from './balance-context.service';
import { TokensSchemaService } from './tokens-schema.service';

@Module({
  imports: [ProfileModule, CommonModule],
  controllers: [TokensController],
  // TokensSchemaService ничего не экспортирует и никем не инжектится: он нужен
  // только ради onModuleInit, который накатывает процедуры баланса. Убрать его
  // из providers — значит перестать накатывать миграцию, ничего при этом не
  // сломав ни в одном вызове; сторож на это — tokens-schema.spec.ts.
  providers: [BalanceContextService, TokensSchemaService],
  exports: [BalanceContextService],
})
export class TokensModule {}
