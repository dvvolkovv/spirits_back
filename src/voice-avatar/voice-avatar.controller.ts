import {
  Controller, Post, Get, Delete, Body, Req, UseGuards, UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { IpRateLimiter } from '../common/guards/ip-rate-limit';
import { VoiceAvatarService } from './voice-avatar.service';

@Controller('voice-avatar')
export class VoiceAvatarController {
  constructor(
    private readonly voice: VoiceAvatarService,
    private readonly limiter: IpRateLimiter,
  ) {}

  /** Загрузка сэмпла голоса + consent. Запускает async профиль+клон. */
  @Post('sample')
  @UseGuards(JwtGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  async uploadSample(
    @CurrentUser() user: any,
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
    @Body('consent') consent: string,
  ) {
    await this.limiter.check(req.ip || 'unknown', 'voice-sample', 10, 60);
    if (!file?.buffer) throw new BadRequestException('no file');
    const consented = consent === 'true' || (consent as any) === true;
    await this.voice.ingestSample(user.userId, file.buffer, consented);
    return { status: 'pending' };
  }

  /** Текущий статус голоса (без voice_id наружу). */
  @Get('status')
  @UseGuards(JwtGuard)
  async status(@CurrentUser() user: any) {
    const v = await this.voice.getUserVoice(user.userId);
    if (!v) return { status: 'none', hasVoice: false };
    return {
      status: v.status,
      hasVoice: v.status === 'ready' && !!v.elevenlabs_voice_id,
      descriptor: v.voice_descriptor || undefined,
      error: v.error_message || undefined,
    };
  }

  @Delete()
  @UseGuards(JwtGuard)
  async remove(@CurrentUser() user: any) {
    await this.voice.removeVoice(user.userId);
    return { ok: true };
  }
}
