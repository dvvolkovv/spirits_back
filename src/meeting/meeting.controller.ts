import { Body, Controller, ForbiddenException, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { MeetingService } from './meeting.service';
import { MeetingProvider } from './meeting-link';

/** Провайдеры, которые ручка принимает. Незнакомое значение — не linkeon. */
const KNOWN_PROVIDERS = new Set<MeetingProvider>(['linkeon', 'talerid', 'meet', 'zoom']);

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
    @Body() body: { agentId: number; code: string; provider?: MeetingProvider; url?: string },
  ) {
    // Провайдер сверяем со списком, а не тернарником.
    //
    // Прежняя редакция отправляла всё, что не 'talerid', в 'linkeon' — и
    // встреча Meet уходила искать свою комнату с кодом вида abc-defg-hij,
    // получая 404. Фича была недостижима через API, а тесты этого не видели:
    // они зовут MeetingService напрямую, минуя контроллер. Поймано запуском
    // на стенде 09.09.2026.
    //
    // Список, а не «всё неизвестное — linkeon»: следующий провайдер иначе
    // молча уедет в свои комнаты, ровно как это случилось с Meet.
    const provider: MeetingProvider = KNOWN_PROVIDERS.has(body?.provider as MeetingProvider)
      ? (body!.provider as MeetingProvider)
      : 'linkeon';
    // Адрес входа — только для площадок, где его не собрать из кода (Zoom).
    // Строку не разбираем и не валидируем здесь: это забота сервиса, который
    // и решает, обязателен ли адрес для этого провайдера.
    const url = typeof body?.url === 'string' && body.url ? body.url : undefined;
    // Имя владельца сервис берёт из профиля сам: в JWT его нет.
    return this.meetings.join(u.userId, Number(body?.agentId), String(body?.code || ''), provider, url);
  }

  @Post(':id/leave')
  async leave(@CurrentUser() u: any, @Param('id') id: string) {
    const call = await this.calls.load(id);
    if (call.user_id !== u.userId) throw new ForbiddenException('not your meeting');
    await this.meetings.leave(id);
    return { ok: true };
  }
}
