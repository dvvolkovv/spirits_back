import { Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { VoiceCallService } from './voice-call.service';

@Controller('voice-call')
@UseGuards(JwtGuard)
export class VoiceCallController {
  constructor(private readonly calls: VoiceCallService) {}

  /**
   * Звонок Роману — для любого ВОШЕДШЕГО пользователя [voice Ф1, owner 2026-08-28].
   * Раньше был admin-only (v1); теперь голос — основной вход в LinkeonOS, и звонок
   * доступен всем залогиненным (списывается с баланса, см. VoiceCallService.complete).
   * Анонимный звонок до входа — отдельный путь (Ф2), не здесь.
   */
  @Post('start')
  async start(@CurrentUser() u: any) {
    return this.calls.start(u.userId);
  }

  @Post(':id/end')
  async end(@CurrentUser() u: any, @Param('id') id: string) {
    const call = await this.calls.load(id);
    if (call.user_id !== u.userId) throw new ForbiddenException('not your call');
    await this.calls.markInterrupted(id);
    return { ok: true };
  }

  @Get(':id')
  async get(@CurrentUser() u: any, @Param('id') id: string) {
    const call = await this.calls.load(id);
    if (call.user_id !== u.userId) throw new ForbiddenException('not your call');
    return call;
  }
}
