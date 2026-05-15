// src/smm/videos/videos.controller.ts
import { Controller, Get, NotFoundException, Param, Post, Body, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PgService } from '../../common/services/pg.service';
import { rowToVideo } from '../entities/smm-video.entity';
import { ApprovalService } from '../producer/approval.service';

@Controller('smm/videos')
@UseGuards(JwtGuard, AdminGuard)
export class VideosController {
  constructor(
    private readonly pg: PgService,
    private readonly approval: ApprovalService,
  ) {}

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const r = await this.pg.query(`SELECT * FROM smm_video WHERE id = $1`, [id]);
    if (r.rows.length === 0) throw new NotFoundException(`video ${id} not found`);
    return rowToVideo(r.rows[0]);
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string) {
    await this.approval.approveVideo(id);
    return { ok: true };
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: { reason?: string }) {
    await this.approval.rejectVideo(id, body?.reason);
    return { ok: true };
  }
}
