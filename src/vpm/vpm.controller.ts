import { Controller, Get, Post, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { VpmService } from './vpm.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class VpmController {
  constructor(private readonly vpm: VpmService) {}

  // Action-style POST mirrors the rest of the admin surface.
  @Post('admin/vpm')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@CurrentUser() u: any, @Body() body: any, @Res() res: Response) {
    const { action, ...data } = body || {};
    switch (action) {
      case 'generate': {
        const out = await this.vpm.generate(String(u.userId), 'manual');
        return res.status(200).json(out);
      }
      case 'list': {
        const items = await this.vpm.listRecommendations({ status: data.status, limit: data.limit });
        return res.status(200).json(items);
      }
      case 'list_runs': {
        const items = await this.vpm.listRuns(data.limit);
        return res.status(200).json(items);
      }
      case 'dismiss': {
        const r = await this.vpm.dismiss(String(data.id), String(u.userId));
        return res.status(200).json(r);
      }
      case 'mark_done': {
        const r = await this.vpm.markDone(String(data.id), String(u.userId));
        return res.status(200).json(r);
      }
      case 'to_backlog': {
        const out = await this.vpm.toBacklog(String(data.id), String(u.userId));
        return res.status(200).json(out);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }

  // Plain GET list for quick admin debugging.
  @Get('admin/vpm/recommendations')
  @UseGuards(JwtGuard, AdminGuard)
  async list(@Query('status') status: string | undefined, @Res() res: Response) {
    const items = await this.vpm.listRecommendations({ status: status as any });
    return res.status(200).json(items);
  }
}
