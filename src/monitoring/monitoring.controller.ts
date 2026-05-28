import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { MonitoringService } from './monitoring.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

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
}
