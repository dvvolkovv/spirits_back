import { Body, Controller, Get, Logger, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { GlobalLlmProviderService, GlobalProviderStatus } from '../common/services/global-llm-provider.service';
import { ANSWER_PROVIDERS, isAnswerProvider, readFallbackConfigs } from '../common/services/llm-fallback';
import { sendTelegramAlert } from '../common/telegram-alert';
import { switchedText } from '../common/global-llm-messages';

/**
 * Общий рубильник модели ответов (spec 2026-10-31-global-llm-switch, раздел 7).
 * Модель без ключа на сервере не выбирается (409 no_key): иначе рубильник
 * показывал бы Kimi, а отвечал бы Claude. Каждое переключение — лог и
 * сообщение в группу алертов.
 */
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminGlobalLlmController {
  private readonly logger = new Logger(AdminGlobalLlmController.name);

  constructor(private readonly global: GlobalLlmProviderService) {}

  @Get('admin/llm-provider')
  async get(@Res() res: Response) {
    const s = await this.global.status();
    return res.status(200).json({ ...s, configured: configured() });
  }

  @Post('admin/llm-provider')
  async set(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const provider = String(body?.provider ?? '');
    if (!isAnswerProvider(provider)) {
      return res.status(400).json({ error: `provider: ${ANSWER_PROVIDERS.map((p) => `'${p}'`).join(' | ')}` });
    }
    const cfg = configured();
    if (provider !== 'claude' && !cfg[provider]) {
      return res.status(409).json({ error: 'no_key', provider });
    }
    const actor = String(user?.userId ?? 'unknown');
    const { previous } = await this.global.set(provider, actor);
    this.logger.log(`llm_provider (все): ${actor}: ${previous} → ${provider}`);
    if (previous !== provider) {
      // Fire-and-forget (ревью 01.11): sendTelegramAlert сама не бросает
      // (sendTelegramPayload гасит сетевые/Telegram-ошибки по каждому чату
      // внутри себя), а ответ админке не должен зависеть от сети до
      // Telegram — повисший запрос туда не должен задержать 200.
      // На test нет TELEGRAM_* — сообщения стенда туда не уходят вовсе.
      void sendTelegramAlert(switchedText(previous, provider, actor));
    }
    // Запись уже прошла успешно — сбой ЭТОГО (повторного) чтения не повод
    // отвечать 500: в ответе — известные значения (новый provider, актор),
    // а не последнее прочитанное ДО записи (ревью 01.11).
    let s: GlobalProviderStatus;
    try {
      s = await this.global.status();
    } catch (e: any) {
      this.logger.warn(`рубильник: статус после записи не прочитан: ${e?.message}`);
      s = { provider, since: null, by: actor };
    }
    return res.status(200).json({ ...s, configured: cfg });
  }
}

function configured(): { qwen: boolean; kimi: boolean } {
  const c = readFallbackConfigs();
  return { qwen: c.qwen !== null, kimi: c.kimi !== null };
}
