import { Controller, Post, Get, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { VkAdsService } from './vk-ads.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('')
export class VkAdsController {
  constructor(private readonly vk: VkAdsService) {}

  // Ручной запуск выгрузки (обычно идёт по cron каждые 3ч).
  @Post('admin/vk-ads/refresh')
  @UseGuards(JwtGuard, AdminGuard)
  async refresh(@Res() res: Response) {
    const r = await this.vk.fetchAndStore();
    return res.status(200).json(r ?? { error: 'VK Ads not configured' });
  }

  // Сводка по креативам + связка с регистрациями/CPR (для UI/проверки).
  @Get('admin/vk-ads/summary')
  @UseGuards(JwtGuard, AdminGuard)
  async summary(@Res() res: Response) {
    return res.status(200).json(await this.vk.summaryForVmm(30));
  }

  // Полная сводка для админ-вкладки «Реклама» (кампании → объявления + период,
  // бюджет/расход, метрики, связка с регистрациями/оплатами).
  @Get('admin/vk-ads/dashboard')
  @UseGuards(JwtGuard, AdminGuard)
  async dashboard(@Res() res: Response) {
    return res.status(200).json(await this.vk.dashboardForAdmin(60));
  }

  @Post('admin/vk-ads')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@Body() body: any, @Res() res: Response) {
    if (body?.action === 'refresh') return res.status(200).json(await this.vk.fetchAndStore() ?? {});
    if (body?.action === 'summary') return res.status(200).json(await this.vk.summaryForVmm(body.window || 30));
    if (body?.action === 'dashboard') return res.status(200).json(await this.vk.dashboardForAdmin(body.window || 60));
    return res.status(400).json({ error: 'unknown action' });
  }
}
