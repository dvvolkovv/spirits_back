import { Body, Controller, Get, Headers, Post, Query, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { MonitoringService } from './monitoring.service';
import { LogsService } from './logs.service';
import { SyntheticService } from './synthetic.service';
import { FunnelService } from './product/funnel.service';
import { EconomyService, EconomyWindow } from './product/economy.service';
import { QualityService, QualityWindow } from './product/quality.service';
import { ProfileDepthService } from './product/profile-depth.service';
import { SummaryService } from './product/summary.service';
import { NetworkingService, NetworkingWindow } from './product/networking.service';
import { ChurnService } from './product/churn.service';
import { SupportService, SupportWindow } from './product/support.service';
import { ContentService, ContentWindow } from './product/content.service';
import { PersonasService } from './product/personas.service';
import { SmsHealthService } from './sms-health.service';
import { OpenRouterHealthService } from './openrouter-health.service';
import { ElevenLabsHealthService } from './elevenlabs-health.service';
import { ClaudeHealthService } from './claude-health.service';
import { BackupHealthService } from './backup-health.service';
import { ModelsRegistryService } from './models-registry.service';
import { JobsMonitorService } from './jobs-monitor.service';
import { ReplicationHealthService } from './replication-health.service';
import { NeoSnapshotHealthService } from './neo-snapshot-health.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

const ECONOMY_WINDOWS: EconomyWindow[] = ['24h', '7d', '30d', '90d', 'all'];
const QUALITY_WINDOWS: QualityWindow[] = ['24h', '7d', '30d', 'all'];
const NETWORKING_WINDOWS: NetworkingWindow[] = ['24h', '7d', '30d', '90d', 'all'];
const SUPPORT_WINDOWS: SupportWindow[] = ['24h', '7d', '30d', '90d', 'all'];
const CONTENT_WINDOWS: ContentWindow[] = ['24h', '7d', '30d', '90d', 'all'];

@Controller('')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly logs: LogsService,
    private readonly funnel: FunnelService,
    private readonly economy: EconomyService,
    private readonly quality: QualityService,
    private readonly profile: ProfileDepthService,
    private readonly synthetic: SyntheticService,
    private readonly summary: SummaryService,
    private readonly networking: NetworkingService,
    private readonly churn: ChurnService,
    private readonly support: SupportService,
    private readonly content: ContentService,
    private readonly personas: PersonasService,
    private readonly smsHealth: SmsHealthService,
    private readonly openrouterHealth: OpenRouterHealthService,
    private readonly elevenlabsHealth: ElevenLabsHealthService,
    private readonly claudeHealth: ClaudeHealthService,
    private readonly backupHealth: BackupHealthService,
    private readonly models: ModelsRegistryService,
    private readonly jobs: JobsMonitorService,
    private readonly replication: ReplicationHealthService,
    private readonly neoSnapshot: NeoSnapshotHealthService,
  ) {}

  @Get('admin/monitoring/overview')
  @UseGuards(JwtGuard, AdminGuard)
  async summaryOverview(@Res() res: Response) {
    try {
      const data = await this.summary.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'summary_failed', message: e?.message || String(e) });
    }
  }

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

  @Get('admin/monitoring/tech/sms')
  @UseGuards(JwtGuard, AdminGuard)
  async smsOverview(@Res() res: Response) {
    try {
      const data = await this.smsHealth.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'sms_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/openrouter')
  @UseGuards(JwtGuard, AdminGuard)
  async openrouterOverview(@Res() res: Response) {
    try {
      const data = await this.openrouterHealth.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'openrouter_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/elevenlabs')
  @UseGuards(JwtGuard, AdminGuard)
  async elevenlabsOverview(@Res() res: Response) {
    try {
      const data = await this.elevenlabsHealth.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'elevenlabs_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/claude')
  @UseGuards(JwtGuard, AdminGuard)
  async claudeOverview(@Res() res: Response) {
    try {
      const data = await this.claudeHealth.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'claude_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/backups')
  @UseGuards(JwtGuard, AdminGuard)
  async backupsOverview(@Res() res: Response) {
    try {
      const data = await this.backupHealth.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'backups_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/models')
  @UseGuards(JwtGuard, AdminGuard)
  async modelsOverview(@Res() res: Response) {
    try {
      const data = await this.models.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'models_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/jobs')
  @UseGuards(JwtGuard, AdminGuard)
  async jobsOverview(@Res() res: Response) {
    try {
      const data = await this.jobs.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'jobs_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/replication')
  @UseGuards(JwtGuard, AdminGuard)
  async replicationOverview(@Res() res: Response) {
    try {
      const data = await this.replication.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'replication_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/neo4j-dr')
  @UseGuards(JwtGuard, AdminGuard)
  async neo4jDrOverview(@Res() res: Response) {
    try {
      const data = await this.neoSnapshot.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'neo4j_dr_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/tech/synthetic')
  @UseGuards(JwtGuard, AdminGuard)
  async syntheticOverview(@Res() res: Response) {
    try {
      const data = await this.synthetic.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'synthetic_failed', message: e?.message || String(e) });
    }
  }

  // Synthetic results push — called by the runner on node-3 every N minutes.
  // Auth: shared secret in x-synthetic-token header (env SYNTHETIC_PUSH_TOKEN).
  @Post('monitoring/synthetic/push')
  async syntheticPush(
    @Headers('x-synthetic-token') token: string | undefined,
    @Body() body: { scenario?: string; success?: boolean; duration_ms?: number; message?: string },
    @Res() res: Response,
  ) {
    const expected = process.env.SYNTHETIC_PUSH_TOKEN || '';
    if (!expected || token !== expected) {
      throw new UnauthorizedException('invalid synthetic token');
    }
    if (!body?.scenario || typeof body.success !== 'boolean') {
      return res.status(400).json({ error: 'scenario + success required' });
    }
    await this.synthetic.record(
      body.scenario,
      body.success,
      Number(body.duration_ms || 0),
      body.message || null,
    );
    return res.status(204).end();
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

  @Get('admin/monitoring/product/personas')
  @UseGuards(JwtGuard, AdminGuard)
  async getPersonas(@Res() res: Response) {
    try {
      const data = await this.personas.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'personas_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/product/support')
  @UseGuards(JwtGuard, AdminGuard)
  async getSupport(@Query('window') window: string | undefined, @Res() res: Response) {
    const w = (SUPPORT_WINDOWS as string[]).includes(window || '') ? (window as SupportWindow) : '30d';
    try {
      const data = await this.support.getOverview(w);
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'support_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/product/content')
  @UseGuards(JwtGuard, AdminGuard)
  async getContent(@Query('window') window: string | undefined, @Res() res: Response) {
    const w = (CONTENT_WINDOWS as string[]).includes(window || '') ? (window as ContentWindow) : '30d';
    try {
      const data = await this.content.getOverview(w);
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'content_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/product/networking')
  @UseGuards(JwtGuard, AdminGuard)
  async getNetworking(@Query('window') window: string | undefined, @Res() res: Response) {
    const w = (NETWORKING_WINDOWS as string[]).includes(window || '') ? (window as NetworkingWindow) : '30d';
    try {
      const data = await this.networking.getOverview(w);
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'networking_failed', message: e?.message || String(e) });
    }
  }

  @Get('admin/monitoring/product/churn')
  @UseGuards(JwtGuard, AdminGuard)
  async getChurn(@Res() res: Response) {
    try {
      const data = await this.churn.getOverview();
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(500).json({ error: 'churn_failed', message: e?.message || String(e) });
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
