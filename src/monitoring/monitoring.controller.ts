import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { MonitoringService } from './monitoring.service';
import { LogsService } from './logs.service';
import { FunnelService } from './product/funnel.service';
import { EconomyService, EconomyWindow } from './product/economy.service';
import { QualityService, QualityWindow } from './product/quality.service';
import { ProfileDepthService } from './product/profile-depth.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

const ECONOMY_WINDOWS: EconomyWindow[] = ['24h', '7d', '30d', '90d', 'all'];
const QUALITY_WINDOWS: QualityWindow[] = ['24h', '7d', '30d', 'all'];

@Controller('')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly logs: LogsService,
    private readonly funnel: FunnelService,
    private readonly economy: EconomyService,
    private readonly quality: QualityService,
    private readonly profile: ProfileDepthService,
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

  @Get('admin/monitoring/tech/databases')
  @UseGuards(JwtGuard, AdminGuard)
  async techDatabases(@Res() res: Response) {
    try {
      const data = await this.monitoring.getDatabases();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(503).json({
        error: 'prometheus_unreachable',
        message: e?.message || String(e),
      });
    }
  }

  @Get('admin/monitoring/logs/labels')
  @UseGuards(JwtGuard, AdminGuard)
  async logsLabels(@Res() res: Response) {
    try {
      const [hosts, jobs, levels] = await Promise.all([
        this.logs.listLabelValues('host'),
        this.logs.listLabelValues('job'),
        this.logs.listLabelValues('level'),
      ]);
      return res.status(200).json({ hosts, jobs, levels });
    } catch (e: any) {
      return res.status(503).json({ error: 'loki_unreachable', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/logs')
  @UseGuards(JwtGuard, AdminGuard)
  async logsQuery(
    @Query('query') query: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    const q = (query || '').trim();
    if (!q) return res.status(400).json({ error: 'query required' });
    const now = Date.now();
    const toNs = (to ? new Date(to).getTime() : now) * 1e6;
    const fromNs = (from ? new Date(from).getTime() : now - 15 * 60 * 1000) * 1e6;
    const lim = Math.min(Math.max(parseInt(limit || '200', 10) || 200, 1), 1000);
    try {
      const data = await this.logs.query({
        query: q,
        from: String(fromNs),
        to: String(toNs),
        limit: lim,
      });
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(503).json({ error: 'loki_query_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/product/quality')
  @UseGuards(JwtGuard, AdminGuard)
  async getQuality(@Query('window') window: string | undefined, @Res() res: Response) {
    const w = (QUALITY_WINDOWS as string[]).includes(window || '') ? (window as QualityWindow) : '30d';
    try {
      const data = await this.quality.getOverview(w);
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'quality_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/product/profile')
  @UseGuards(JwtGuard, AdminGuard)
  async getProfileDepth(@Res() res: Response) {
    try {
      const data = await this.profile.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'profile_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/economy')
  @UseGuards(JwtGuard, AdminGuard)
  async getEconomy(@Query('window') window: string | undefined, @Res() res: Response) {
    const w = (ECONOMY_WINDOWS as string[]).includes(window || '') ? (window as EconomyWindow) : '30d';
    try {
      const data = await this.economy.getOverview(w);
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'economy_failed', message: e?.message || String(e) });
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
