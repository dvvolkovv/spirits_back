import { Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
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

  /**
   * Реплики САМОГО пользователя из его завершённых голосовых разговоров начиная с курсора
   * (owner 2026-09-01: разговоры с Романом обогащают профиль). Устройство подтягивает СВОИ
   * слова и кормит ими on-device каскад (AskContext.rememberConversationTurn) — профиль строится
   * на устройстве, сервер лишь отдаёт юзеру его же данные. Только role=user (не ассистент).
   * ⚠️ Объявлено ДО @Get(':id'), иначе 'profile-turns' матчится как :id.
   */
  @Get('profile-turns')
  async profileTurns(@CurrentUser() u: any, @Query('since') since?: string) {
    return this.calls.profileTurns(u.userId, Number(since) || 0);
  }

  @Get(':id')
  async get(@CurrentUser() u: any, @Param('id') id: string) {
    const call = await this.calls.load(id);
    if (call.user_id !== u.userId) throw new ForbiddenException('not your call');
    return call;
  }
}
