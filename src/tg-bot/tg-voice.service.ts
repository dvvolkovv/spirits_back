import { Injectable, Logger } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import { TgGrammyClient } from './tg-grammy.client';

@Injectable()
export class TgVoiceService {
  private readonly logger = new Logger(TgVoiceService.name);
  // Ленивая инициализация: OpenAI() в конструкторе кидает если apiKey не задан,
  // что роняло весь Nest-bootstrap на test-сервере без OPENAI_API_KEY (где voice
  // не нужен, потому что нет TG_BOT_TOKEN). Создаём клиент при первом вызове.
  private _openai: OpenAI | null = null;

  constructor(private readonly grammy: TgGrammyClient) {}

  private get openai(): OpenAI {
    if (!this._openai) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY not set — voice STT/TTS unavailable');
      }
      this._openai = new OpenAI({ apiKey });
    }
    return this._openai;
  }

  /**
   * Whisper STT. На нас (Linkeon) — не списываем с пользователя.
   * Возвращает только текст (cost не отдаём наружу, потому что не биллится).
   */
  async transcribe(fileId: string): Promise<string> {
    const file = await this.grammy.getFile(fileId);
    if (!file.file_path) throw new Error('no file_path in Telegram getFile response');
    const buf = await this.grammy.downloadFile(file.file_path);

    const resp = await this.openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: await toFile(buf, 'voice.oga', { type: 'audio/ogg' }),
      language: 'ru',
    });
    return resp.text.trim();
  }

  /**
   * OpenAI TTS. Возвращает Buffer .ogg/opus + стоимость в USD.
   * tts-1: $15 за 1M символов. Для коротких ответов в Telegram — копейки.
   */
  async synthesize(text: string): Promise<{ buffer: Buffer; costUsd: number }> {
    const resp = await this.openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      response_format: 'opus',
    });
    const buffer = Buffer.from(await resp.arrayBuffer());
    const costUsd = (text.length / 1_000_000) * 15;
    return { buffer, costUsd };
  }
}
