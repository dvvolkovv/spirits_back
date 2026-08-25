import { Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { VoiceCallService } from './voice-call.service';

@Controller('voice-call')
@UseGuards(JwtGuard)
export class VoiceCallController {
  constructor(private readonly calls: VoiceCallService) {}

  /**
   * v1 — только админы. Проверка серверная: скрытая кнопка на фронте это
   * удобство, а не защита.
   */
  @Post('start')
  async start(@CurrentUser() u: any) {
    if (!u?.isAdmin) throw new ForbiddenException('voice calls are admin-only in v1');
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
