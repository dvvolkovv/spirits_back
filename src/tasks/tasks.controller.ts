import { Body, Controller, Get, Param, Patch, Query, Req, Res, UseGuards, Optional } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { TasksService } from './tasks.service';

/**
 * Admin-only endpoints for inspecting per-user task memory.
 * Frontend admin drawer (UserActivityDrawer) hits these.
 *
 * Endpoints live in tasks module rather than admin.controller because
 * the admin module had been losing edits to drift; keeping tasks
 * routing isolated avoids that conflict.
 */
@Controller('')
export class TasksController {
  constructor(@Optional() private readonly tasks?: TasksService) {}

  @Get('admin/users/:phone/tasks')
  @UseGuards(JwtGuard)
  async list(@Param('phone') phone: string, @Res() res: Response) {
    if (!this.tasks) return res.status(503).json({ error: 'tasks service not configured' });
    const items = await this.tasks.listForAdmin(phone);
    return res.status(200).json(items);
  }

  @Get('admin/tasks/:taskId')
  @UseGuards(JwtGuard)
  async details(
    @Param('taskId') taskId: string,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    if (!this.tasks) return res.status(503).json({ error: 'tasks service not configured' });
    const lim = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) : 50;
    const data = await this.tasks.getTaskFull(taskId, lim);
    if (!data) return res.status(404).json({ error: 'task not found' });
    return res.status(200).json(data);
  }

  @Get('user/tasks')
  @UseGuards(JwtGuard)
  async listUser(@Req() req: any, @Res() res: Response) {
    if (!this.tasks) return res.status(503).json({ error: 'tasks service not configured' });
    const userId: string = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const items = await this.tasks.listForUser(userId);
    return res.status(200).json(items);
  }

  @Get('user/tasks/:taskId')
  @UseGuards(JwtGuard)
  async detailsUser(
    @Param('taskId') taskId: string,
    @Query('limit') limit: string | undefined,
    @Req() req: any,
    @Res() res: Response,
  ) {
    if (!this.tasks) return res.status(503).json({ error: 'tasks service not configured' });
    const userId: string = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const lim = limit ? Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200) : 30;
    const data = await this.tasks.getTaskFullForUser(taskId, userId, lim);
    if (!data) return res.status(404).json({ error: 'task not found' });
    return res.status(200).json(data);
  }

  @Patch('user/tasks/:taskId')
  @UseGuards(JwtGuard)
  async setStatusUser(
    @Param('taskId') taskId: string,
    @Body() body: { status?: string },
    @Req() req: any,
    @Res() res: Response,
  ) {
    if (!this.tasks) return res.status(503).json({ error: 'tasks service not configured' });
    const userId: string = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const status = body?.status;
    if (!status || !['active', 'archived', 'done'].includes(status)) {
      return res.status(400).json({ error: 'invalid status', allowed: ['active', 'archived', 'done'] });
    }
    try {
      const updated = await this.tasks.setStatus(taskId, userId, status as any);
      if (!updated) return res.status(404).json({ error: 'task not found' });
      return res.status(200).json(updated);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'failed' });
    }
  }
}
