import { Controller, Get, Post, Put, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AvatarService } from './avatar.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import * as multer from 'multer';

@Controller('')
export class AvatarController {
  private upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

  constructor(private readonly avatarService: AvatarService) {}

  @Get('avatar')
  @UseGuards(JwtGuard)
  async getAvatar(@CurrentUser() user: any, @Res() res: Response) {
    const avatar = await this.avatarService.getAvatar(user.phone);
    if (!avatar) return res.status(404).json({ error: 'No avatar' });

    // If local file, serve it directly as binary
    if (avatar.url.startsWith('/static/')) {
      const path = require('path');
      const filePath = path.join(process.cwd(), 'public', avatar.url.replace('/static/', ''));
      return res.sendFile(filePath);
    }

    // If remote URL, redirect
    return res.redirect(avatar.url);
  }

  @Post('avatar')
  @UseGuards(JwtGuard)
  async uploadAvatar(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    return new Promise((resolve) => {
      this.upload.single('file')(req as any, res as any, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        const file = (req as any).file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });
        try {
          const result = await this.avatarService.uploadAvatar(user.phone, file.buffer, file.mimetype);
          resolve(res.status(200).json(result));
        } catch (e) {
          resolve(res.status(500).json({ error: e.message }));
        }
      });
    });
  }

  @Put('avatar')
  @UseGuards(JwtGuard)
  async uploadAvatarPut(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    return this.uploadAvatar(user, req, res);
  }

  @Get('0cdacf32-7bfd-4888-b24f-3a6af3b5f99e/agent/avatar/:agentId')
  async getAgentAvatar(@Param('agentId') agentId: string, @Res() res: Response) {
    const url = await this.avatarService.getAgentAvatar(agentId);
    if (!url) return res.status(404).json({ error: 'No avatar' });
    return res.redirect(url);
  }
}
