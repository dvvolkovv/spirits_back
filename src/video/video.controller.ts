// src/video/video.controller.ts
import {
  Controller, Post, Get, Delete, Body, Param, Query, Req, Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { VideoService, InsufficientTokensError } from './video.service';
import { CreateVideoJobDto } from './video.dto';

@Controller('video')
export class VideoController {
  constructor(private readonly video: VideoService) {}

  @Post('jobs')
  @UseGuards(JwtGuard)
  async createJob(
    @CurrentUser() user: any,
    @Res() res: Response,
    @Body() dto: CreateVideoJobDto,
  ) {
    try {
      const result = await this.video.createJob(user.phone, dto);
      return res.json(result);
    } catch (e: any) {
      if (e instanceof InsufficientTokensError) {
        return res.status(402).json({
          error: 'insufficient_tokens',
          balance: e.balance,
          required: e.required,
        });
      }
      if (e?.status && typeof e.status === 'number') {
        return res.status(e.status).json({ error: e.message });
      }
      return res.status(500).json({ error: e.message || 'internal' });
    }
  }

  @Get('jobs/:id')
  @UseGuards(JwtGuard)
  async getJob(@CurrentUser() user: any, @Param('id') id: string) {
    return this.video.getJob(user.phone, id);
  }

  @Get('jobs')
  @UseGuards(JwtGuard)
  async listJobs(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const jobs = await this.video.listJobs(user.phone, {
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { jobs };
  }

  @Delete('jobs/:id')
  @UseGuards(JwtGuard)
  async deleteJob(@CurrentUser() user: any, @Param('id') id: string) {
    await this.video.deleteJob(user.phone, id);
    return { ok: true };
  }
}
