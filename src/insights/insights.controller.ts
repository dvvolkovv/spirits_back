import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { InsightsService } from './insights.service';
import { InsightsStore } from './insights-store.service';
import { previousWeekMsk, weekOf } from './insights-week';

@Controller('')
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly store: InsightsStore,
  ) {}

  /** Действия как у остальной админки: run (прогон прошлой или заданной недели), status, enable, disable. */
  @Post('admin/insights')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@Body() body: any, @Res() res: Response) {
    switch (body?.action) {
      case 'run': {
        let week;
        try {
          week = body?.week ? weekOf(String(body.week)) : previousWeekMsk(new Date());
        } catch (e: any) {
          return res.status(400).json({ error: e.message });
        }
        const runId = await this.insights.startManual(week);
        return res.status(202).json({ runId, weekStart: week.weekStart });
      }
      case 'status':
        return res.status(200).json(await this.store.status());
      case 'enable':
        await this.store.setEnabled(true);
        return res.status(200).json({ enabled: true });
      case 'disable':
        await this.store.setEnabled(false);
        return res.status(200).json({ enabled: false });
      default:
        return res.status(400).json({ error: `Unknown action: ${body?.action}` });
    }
  }
}
