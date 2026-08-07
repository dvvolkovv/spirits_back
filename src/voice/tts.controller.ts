import { BadRequestException, Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { MiscService } from '../misc/misc.service';
import { TtsFormat, TtsService } from './tts.service';

const MAX_TEXT_LENGTH = 1000;
// $1 = 100k Linkeon-tokens — тот же курс, что в chat.service.ts (Маша/claude CLI billing).
const USD_TO_LINKEON_TOKENS = 100_000;

@Controller('')
export class TtsController {
  constructor(
    private readonly ttsService: TtsService,
    private readonly miscService: MiscService,
  ) {}

  /**
   * text → audio для hands-free голосового цикла лаунчера.
   * Auth: тот же JwtGuard/CurrentUser паттерн, что у GET /webhook/user/tokens
   * (tokens.controller.ts) и других защищённых webhook-эндпоинтов — НЕ
   * ручная проверка Bearer, как в chat.controller.ts POST /webhook/soulmate/chat
   * (там auth встроен в n8n-совместимое поведение воркфлоу и намеренно не бросает).
   */
  @Post('tts')
  @UseGuards(JwtGuard)
  async tts(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw new BadRequestException('text is required');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new BadRequestException(`text too long: ${text.length} > ${MAX_TEXT_LENGTH}`);
    }
    const format: TtsFormat = body?.format === 'mp3' ? 'mp3' : 'opus';

    // TODO(billing): списываем по факту синтеза (не резервируем заранее — TTS
    // отвечает быстро, race на параллельных запросах того же юзера теоретически
    // возможен, но некритична (цена одного вызова — единицы центов). Если TTS
    // станет высокочастотным в голосовом цикле — добавить pre-check с резервом,
    // как у /webhook/imagegen (misc.service.ts generateImage: check → generate → deduct).
    const { audio, cost } = await this.ttsService.synthesize(text, format);
    const tokensSpent = Math.ceil(cost * USD_TO_LINKEON_TOKENS);
    try {
      await this.miscService.deductTokens(user.userId, tokensSpent);
    } catch (e: any) {
      // Не роняем ответ юзеру из-за сбоя списания — аудио уже сгенерировано и
      // оплачено нами (OpenAI), терять его ради биллинг-глюка не стоит.
      // eslint-disable-next-line no-console
      console.warn(`[tts] deductTokens failed for ${user.userId}: ${e?.message}`);
    }

    const contentType = format === 'mp3' ? 'audio/mpeg' : 'audio/ogg';
    res.setHeader('Content-Type', contentType);
    // USD-стоимость синтеза (как costUsd у TgVoiceService.synthesize) — не
    // токены. Списанные Linkeon-токены — tokensSpent (см. deductTokens выше).
    res.setHeader('X-TTS-Cost', cost.toFixed(6));
    res.setHeader('X-TTS-Tokens-Spent', String(tokensSpent));
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(audio);
  }
}
