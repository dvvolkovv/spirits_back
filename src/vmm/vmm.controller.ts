import { Controller, Get, Post, Body, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { VmmService } from './vmm.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class VmmController {
  constructor(private readonly vmm: VmmService) {}

  // Action-style POST mirrors VPM / the rest of the admin surface.
  @Post('admin/vmm')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@CurrentUser() u: any, @Body() body: any, @Res() res: Response) {
    const { action, ...data } = body || {};
    switch (action) {
      case 'generate': {
        const out = await this.vmm.generate(String(u.userId), 'manual');
        return res.status(200).json(out);
      }
      case 'list': {
        const items = await this.vmm.listRecommendations({ status: data.status, limit: data.limit });
        return res.status(200).json(items);
      }
      case 'list_runs': {
        const items = await this.vmm.listRuns(data.limit);
        return res.status(200).json(items);
      }
      case 'dismiss': {
        const r = await this.vmm.dismiss(String(data.id), String(u.userId));
        return res.status(200).json(r);
      }
      case 'mark_done': {
        const r = await this.vmm.markDone(String(data.id), String(u.userId));
        return res.status(200).json(r);
      }
      case 'to_backlog': {
        const out = await this.vmm.toBacklog(String(data.id), String(u.userId));
        return res.status(200).json(out);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }

  @Get('admin/vmm/recommendations')
  @UseGuards(JwtGuard, AdminGuard)
  async list(@Query('status') status: string | undefined, @Res() res: Response) {
    const items = await this.vmm.listRecommendations({ status: status as any });
    return res.status(200).json(items);
  }
}
