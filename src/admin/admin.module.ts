import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminProductsController } from './admin-products.controller';
import { AdminProductsService } from './admin-products.service';
import { CommonModule } from '../common/common.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { ReferralModule } from '../referral/referral.module';

@Module({
  imports: [CommonModule, SchedulerModule, ReferralModule],
  // AdminProductsController — раздел «Сайты и боты». Зарегистрирован здесь, а
  // не только существует: маршруты незарегистрированного контроллера отдают
  // 404 при зелёных юнит-тестах. Сторож — admin-products.controller.spec.ts.
  controllers: [AdminController, AdminProductsController],
  providers: [AdminService, AdminProductsService],
})
export class AdminModule {}
