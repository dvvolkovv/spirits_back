import { Controller, Get, Post, Body, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { BacklogService } from './backlog.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class BacklogController {
  constructor(private readonly backlog: BacklogService) {}

  // Action-based POST matches the style of admin/coupons and admin/referral.
  // The frontend AdminBacklogView speaks only this endpoint.
  @Post('admin/backlog')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const { action, ...data } = body || {};
    switch (action) {
      case 'list': {
        const items = await this.backlog.list();
        return res.status(200).json(items);
      }
      case 'get': {
        const out = await this.backlog.get(String(data.id));
        return res.status(200).json(out);
      }
      case 'create': {
        const item = await this.backlog.create(String(user.userId), data);
        return res.status(200).json(item);
      }
      case 'update': {
        const item = await this.backlog.update(String(data.id), data);
        return res.status(200).json(item);
      }
      case 'delete': {
        const r = await this.backlog.remove(String(data.id));
        return res.status(200).json(r);
      }
      case 'comment': {
        const c = await this.backlog.addComment(String(data.id), String(user.userId), String(data.content || ''));
        return res.status(200).json(c);
      }
      case 'delete_comment': {
        const r = await this.backlog.deleteComment(String(data.comment_id));
        return res.status(200).json(r);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }

  // Plain GET kept for quick admin debugging from a browser; same auth.
  @Get('admin/backlog')
  @UseGuards(JwtGuard, AdminGuard)
  async list(@Res() res: Response) {
    const items = await this.backlog.list();
    return res.status(200).json(items);
  }
}
