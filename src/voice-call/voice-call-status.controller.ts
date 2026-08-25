import { Controller, Get } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

/**
 * Сколько звонков идёт прямо сейчас. Нужен deploy.sh, чтобы не рестартовать
 * посреди разговора: рестарт рвёт мост job'ов молча — ответ специалиста не
 * приходит, ошибки нет, в истории пусто. Та же грабля, что с чат-стримами.
 *
 * Без авторизации сознательно, как и `chat/active-streams` рядом: у скрипта
 * нет токена, а наружу уходит одно число без подробностей о том, кто говорит.
 *
 * Путь намеренно ОТДЕЛЬНЫЙ, не `voice-call/active`: в VoiceCallController есть
 * `@Get(':id')` под JwtGuard, и он поймал бы `active` как идентификатор звонка,
 * ответив 401. Зависеть от порядка регистрации контроллеров не хочется.
 */
@Controller('voice-call-status')
export class VoiceCallStatusController {
  constructor(private readonly pg: PgService) {}

  @Get('active')
  async active(): Promise<{ active: number }> {
    try {
      const res = await this.pg.query(
        `SELECT count(*)::int AS n FROM voice_calls WHERE status IN ('dialing','active')`,
      );
      return { active: Number(res.rows[0]?.n ?? 0) };
    } catch {
      // БД недоступна — не блокируем деплой числом-призраком.
      return { active: 0 };
    }
  }
}
