import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminProductsController } from './admin-products.controller';
import { AdminProductsService } from './admin-products.service';
import { AdminLlmProviderController } from './admin-llm-provider.controller';
import { AdminGlobalLlmController } from './admin-global-llm.controller';
import { CommonModule } from '../common/common.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { ReferralModule } from '../referral/referral.module';
import { RetentionModule } from '../retention/retention.module';

@Module({
  imports: [CommonModule, SchedulerModule, ReferralModule, RetentionModule],
  // AdminProductsController — раздел «Сайты и боты». Зарегистрирован здесь, а
  // не только существует: маршруты незарегистрированного контроллера отдают
  // 404 при зелёных юнит-тестах. Сторож — admin-products.controller.spec.ts.
  controllers: [AdminController, AdminProductsController, AdminLlmProviderController, AdminGlobalLlmController],
  providers: [AdminService, AdminProductsService],
  exports: [AdminService],
})
export class AdminModule {}
