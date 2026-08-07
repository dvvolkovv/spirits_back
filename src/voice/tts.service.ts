import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

export type TtsFormat = 'opus' | 'mp3';

/**
 * OpenAI TTS для «hands-free» голосового цикла лаунчера (текст → аудио).
 * Идиома скопирована с TgVoiceService.synthesize (src/tg-bot/tg-voice.service.ts):
 * та же ленивая инициализация клиента (иначе бэк падает на bootstrap там, где
 * OPENAI_API_KEY не задан — например test-сервер) и та же формула стоимости.
 */
@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  private _openai: OpenAI | null = null;

  private get openai(): OpenAI {
    if (!this._openai) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY not set — TTS unavailable');
      }
      this._openai = new OpenAI({ apiKey });
    }
    return this._openai;
  }

  /**
   * tts-1, голос alloy — читает русский разборчиво и звучит тепло-нейтрально,
   * подходит и для русской, и для английской реплики без переключения голоса.
   * $15 / 1M символов (см. TgVoiceService) — тот же тариф, что у tg-bot.
   */
  async synthesize(text: string, format: TtsFormat = 'opus'): Promise<{ audio: Buffer; cost: number }> {
    const resp = await this.openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      response_format: format,
    });
    const audio = Buffer.from(await resp.arrayBuffer());
    const cost = (text.length / 1_000_000) * 15;
    return { audio, cost };
  }
}
