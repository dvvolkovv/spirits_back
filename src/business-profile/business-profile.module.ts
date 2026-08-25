import { Module, Global } from '@nestjs/common';
import { BusinessProfileService } from './business-profile.service';
import { BusinessProfileController } from './business-profile.controller';

// @Global — как TasksModule: ChatService зовёт сервис, не импортируя модуль.
@Global()
@Module({
  controllers: [BusinessProfileController],
  providers: [BusinessProfileService],
  exports: [BusinessProfileService],
})
export class BusinessProfileModule {}
