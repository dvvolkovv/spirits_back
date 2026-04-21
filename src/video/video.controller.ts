// src/video/video.controller.ts
import {
  Controller, Post, Get, Delete, Body, Param, Query, Req, Res,
  UseGuards, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { VideoService, InsufficientTokensError } from './video.service';
import { CreateVideoJobDto } from './video.dto';
import { IpRateLimiter } from '../common/guards/ip-rate-limit';

@Controller('video')
export class VideoController {
  constructor(
    private readonly video: VideoService,
    private readonly limiter: IpRateLimiter,
  ) {}

  @Post('jobs')
  @UseGuards(JwtGuard)
  async createJob(
    @CurrentUser() user: any,
    @Req() req: Request,
    @Res() res: Response,
    @Body() dto: CreateVideoJobDto,
  ) {
    try {
      await this.limiter.check(req.ip || 'unknown', 'video-create', 20, 60);
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

  @Post('upload-image')
  @UseGuards(JwtGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadImage(
    @CurrentUser() user: any,
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.limiter.check(req.ip || 'unknown', 'video-upload', 60, 60);
    const url = await this.video.uploadUserAsset(
      user.phone,
      'image',
      file.buffer,
      file.mimetype,
      file.originalname,
    );
    return { url };
  }

  @Post('upload-audio')
  @UseGuards(JwtGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async uploadAudio(
    @CurrentUser() user: any,
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.limiter.check(req.ip || 'unknown', 'video-upload', 60, 60);
    const url = await this.video.uploadUserAsset(
      user.phone,
      'audio',
      file.buffer,
      file.mimetype,
      file.originalname,
    );
    return { url };
  }
}
