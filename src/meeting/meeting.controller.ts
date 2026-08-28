import { Body, Controller, ForbiddenException, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { MeetingService } from './meeting.service';

@Controller('meeting')
@UseGuards(JwtGuard)
export class MeetingController {
  constructor(
    private readonly meetings: MeetingService,
    private readonly calls: VoiceCallService,
  ) {}

  /**
   * Позвать ассистента во встречу. v1 админский, как и весь голосовой блок.
   *
   * Проверка серверная: скрытая кнопка на фронте — удобство, а не защита.
   */
  @Post('join')
  async join(
    @CurrentUser() u: any,
    @Body() body: { agentId: number; code: string },
  ) {
    if (!u?.isAdmin) throw new ForbiddenException('meetings are admin-only in v1');
    // Имя владельца сервис берёт из профиля сам: в JWT его нет.
    return this.meetings.join(u.userId, Number(body?.agentId), String(body?.code || ''));
  }

  @Post(':id/leave')
  async leave(@CurrentUser() u: any, @Param('id') id: string) {
    const call = await this.calls.load(id);
    if (call.user_id !== u.userId) throw new ForbiddenException('not your meeting');
    await this.meetings.leave(id);
    return { ok: true };
  }
}
