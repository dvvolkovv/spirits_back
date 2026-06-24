import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';

/**
 * Потоковый STT через Yandex SpeechKit v3 (gRPC bidi-stream RecognizeStreaming).
 * Авторизация — Api-Key сервисного аккаунта (YANDEX_SPEECHKIT_API_KEY).
 * Принимает LPCM 16-bit LE / 16 кГц / моно, отдаёт partial + final текст.
 */
export interface SttStreamCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
  onEnd: () => void;
}

export interface SttStreamHandle {
  push: (chunk: Buffer) => void;
  end: () => void;
}

const SK_ENDPOINT = 'stt.api.cloud.yandex.net:443';

@Injectable()
export class SpeechkitSttService implements OnModuleInit {
  private readonly logger = new Logger(SpeechkitSttService.name);
  private RecognizerCtor: any = null;

  onModuleInit() {
    try {
      const protoDir = path.join(process.cwd(), 'proto');
      const def = protoLoader.loadSync(
        path.join(protoDir, 'yandex/cloud/ai/stt/v3/stt_service.proto'),
        { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [protoDir] },
      );
      const pkg: any = grpc.loadPackageDefinition(def);
      this.RecognizerCtor = pkg.speechkit.stt.v3.Recognizer;
      this.logger.log('SpeechKit v3 proto loaded');
    } catch (e: any) {
      this.logger.error(`SpeechKit proto load failed: ${e.message}`);
    }
  }

  get available(): boolean {
    return !!this.RecognizerCtor && !!process.env.YANDEX_SPEECHKIT_API_KEY;
  }

  /**
   * Открывает потоковую сессию распознавания. Возвращает handle для подачи
   * аудио-чанков (LPCM16/16k/mono) и завершения. Текст приходит в колбэки.
   */
  openStream(cb: SttStreamCallbacks): SttStreamHandle {
    const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
    if (!this.RecognizerCtor || !apiKey) {
      cb.onError(new Error('SpeechKit STT не сконфигурирован'));
      return { push: () => {}, end: () => {} };
    }

    const client = new this.RecognizerCtor(SK_ENDPOINT, grpc.credentials.createSsl());
    const md = new grpc.Metadata();
    md.add('authorization', `Api-Key ${apiKey}`);
    // Отказ от хранения аудио Яндексом для обучения моделей (приватность).
    md.add('x-data-logging-enabled', 'false');

    const call = client.RecognizeStreaming(md);
    let closed = false;
    const safeClose = () => { if (!closed) { closed = true; try { client.close(); } catch {} } };

    call.on('data', (resp: any) => {
      const pull = (u: any) => (u?.alternatives || []).map((a: any) => a.text).join(' ').trim();
      if (resp.partial) { const t = pull(resp.partial); if (t) cb.onPartial(t); }
      // Коммитим финал РОВНО ОДИН раз. SpeechKit на одну фразу шлёт и `final`,
      // и позже `final_refinement.normalized_text` (нормализованный тот же текст) —
      // коммит обоих давал дубль (одно сразу, второе с задержкой). Берём только
      // final. (Нормализацию чисел/дат можно вернуть позже как REPLACE последнего
      // сегмента, а не append — иначе снова дубль.)
      if (resp.final) { const t = pull(resp.final); if (t) cb.onFinal(t); }
    });
    call.on('error', (err: Error) => { safeClose(); cb.onError(err); });
    call.on('end', () => { safeClose(); cb.onEnd(); });

    // Первое сообщение — опции сессии.
    try {
      call.write({ session_options: { recognition_model: {
        audio_format: { raw_audio: { audio_encoding: 'LINEAR16_PCM', sample_rate_hertz: 16000, audio_channel_count: 1 } },
        text_normalization: { text_normalization: 'TEXT_NORMALIZATION_ENABLED' },
        language_restriction: { restriction_type: 'WHITELIST', language_code: ['ru-RU'] },
        audio_processing_type: 'REAL_TIME',
      } } });
    } catch (e: any) {
      safeClose();
      cb.onError(e);
      return { push: () => {}, end: () => {} };
    }

    return {
      push: (chunk: Buffer) => {
        if (closed) return;
        try { call.write({ chunk: { data: chunk } }); } catch (e: any) { cb.onError(e); }
      },
      end: () => {
        if (closed) return;
        try { call.end(); } catch {}
      },
    };
  }
}
