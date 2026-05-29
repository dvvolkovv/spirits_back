import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { MonitoringService } from './monitoring.service';
import { FunnelService } from './product/funnel.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly funnel: FunnelService,
  ) {}

  @Get('admin/monitoring/tech/overview')
  @UseGuards(JwtGuard, AdminGuard)
  async techOverview(@Res() res: Response) {
    try {
      const [nodes, probes] = await Promise.all([
        this.monitoring.getNodeOverview(),
        this.monitoring.getProbes(),
      ]);
      return res.status(200).json({
        nodes,
        probes,
        generatedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      return res.status(503).json({
        error: 'prometheus_unreachable',
        message: e?.message || String(e),
      });
    }
  }

  @Get('admin/monitoring/funnel')
  @UseGuards(JwtGuard, AdminGuard)
  async getFunnel(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('source') source: string | undefined,
    @Res() res: Response,
  ) {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 3600 * 1000);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'invalid_date' });
    }
    try {
      const data = await this.funnel.getFunnel(fromDate.toISOString(), toDate.toISOString(), source || null);
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'funnel_failed', message: e?.message || String(e) });
    }
  }
}
