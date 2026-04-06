import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { ProfileModule } from '../profile/profile.module';

@Module({
  imports: [ProfileModule],
  controllers: [TokensController],
})
export class TokensModule {}
