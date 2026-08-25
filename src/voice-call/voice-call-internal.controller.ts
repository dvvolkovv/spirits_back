import { BadRequestException, Controller, Headers, Logger, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { SpecialistJobService } from './specialist-job.service';
import { VoiceCallService } from './voice-call.service';
import { verifyBody } from './hmac';
import { AskResult, CompletePayload } from './voice-call.types';

/**
 * Ручки, которые зовёт воркер linkeon-voice-host. Закрыты HMAC-подписью тела.
 *
 * Ровно та ошибка, из-за которой пришлось выпиливать dozvon: там аналогичная
 * ручка приёма записи не проверяла ничего. Здесь проверка обязательная, и без
 * секрета в окружении модуль не поднимается (см. voice-call.module.ts).
 */
@Controller('voice-call/internal')
export class VoiceCallInternalController {
  private readonly logger = new Logger(VoiceCallInternalController.name);

  constructor(
    private readonly jobs: SpecialistJobService,
    private readonly calls: VoiceCallService,
  ) {}

  /**
   * Тело здесь — Buffer, а не разобранный объект: на этот путь в main.ts
   * навешен сырой парсер. Проверяем подпись по байтам и разбираем сами.
   */
  private parseSigned<T>(req: Request, signature: string): T {
    // Секрет читаем на КАЖДОМ запросе, а не в константе модуля: process.env
    // наполняется из .env через ConfigModule.forRoot(), который отрабатывает
    // позже вычисления module-level констант. Иначе ручка была бы мертва даже
    // при заданном секрете.
    const secret = process.env.VOICE_CALLBACK_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException('voice call callbacks are not configured');
    }
    const raw: Buffer | string = (req as any).body;
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    if (!verifyBody(secret, text, signature)) {
      throw new UnauthorizedException('bad signature');
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BadRequestException('malformed json');
    }
  }

  @Post('ask')
  async ask(
    @Headers('x-voice-signature') signature: string,
    @Req() req: Request,
  ): Promise<AskResult> {
    const body = this.parseSigned<{ callId: string; specialist: string; question: string }>(req, signature);
    const call = await this.calls.load(body.callId);
    return this.jobs.ask(body.callId, call.room_name, call.user_id, body.specialist, body.question);
  }

  @Post('complete')
  async complete(
    @Headers('x-voice-signature') signature: string,
    @Req() req: Request,
  ) {
    const body = this.parseSigned<{ callId: string } & CompletePayload>(req, signature);
    await this.calls.complete(body.callId, { transcript: body.transcript, usage: body.usage });
    return { ok: true };
  }

  @Post('failed')
  async failed(
    @Headers('x-voice-signature') signature: string,
    @Req() req: Request,
  ) {
    const body = this.parseSigned<{ callId: string; reason: string }>(req, signature);
    await this.calls.fail(body.callId, body.reason);
    return { ok: true };
  }
}
