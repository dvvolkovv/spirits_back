import { Body, Controller, Get, Logger, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
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
      await sendTelegramAlert(switchedText(previous, provider, actor)).catch((e: any) =>
        this.logger.warn(`сообщение о рубильнике не отправлено: ${e?.message}`),
      );
    }
    const s = await this.global.status();
    return res.status(200).json({ ...s, configured: cfg });
  }
}

function configured(): { qwen: boolean; kimi: boolean } {
  const c = readFallbackConfigs();
  return { qwen: c.qwen !== null, kimi: c.kimi !== null };
}
