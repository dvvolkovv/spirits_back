import { Module } from '@nestjs/common';
import { VkAdsController } from './vk-ads.controller';
import { VkAdsService } from './vk-ads.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [VkAdsController],
  providers: [VkAdsService],
  exports: [VkAdsService],
})
export class VkAdsModule {}
