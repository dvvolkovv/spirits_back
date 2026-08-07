// src/speech/speech.controller.ts
import { Controller, Get, Param, UseGuards, NotFoundException } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { StorageService } from '../common/services/storage.service';
import { LanguageService } from '../common/services/language.service';
import { SpeechService } from './speech.service';
import { VOICE_CATALOG, providerForLang } from './voices';

const SPEECH_BUCKET = process.env.SPEECH_BUCKET || 'linkeon-assets';

/** id клипа — uuid-колонка в БД: мусорная строка в WHERE id = $1 даёт 22P02
 *  и 500-ку вместо честной 404, поэтому отсекаем её до запроса. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Глобальный префикс приложения — 'webhook' (main.ts:16), поэтому в декораторе
// его писать не надо: маршруты и так лягут на /webhook/speech/*.
@Controller('speech')
export class SpeechController {
  constructor(
    private readonly speech: SpeechService,
    private readonly language: LanguageService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Каталог голосов под язык пользователя: в английском интерфейсе
   * Yandex-голоса показывать бессмысленно — их не выберет провайдер.
   * Объявлен ДО ':id', иначе '/voices' уедет в параметр маршрута.
   *
   * Язык берётся только из профиля через resolveUserLanguage: providerForLang
   * строго сравнивает lang === 'ru' и не нормализует вход, так что сырой тег
   * из query или Accept-Language ('ru-RU') молча увёл бы русского пользователя
   * на OpenAI-ветку. Поэтому параметра lang у эндпоинта нет и быть не должно.
   */
  @Get('voices')
  @UseGuards(JwtGuard)
  async voices(@CurrentUser() user: any) {
    const lang = await this.language.resolveUserLanguage(user.userId);
    const provider = providerForLang(lang);
    // sampleUrl собирает бэкенд, а не фронт: базовый публичный URL MinIO живёт
    // в MINIO_PUBLIC_URL и фронту неизвестен. Берём его через StorageService,
    // чтобы адрес превью совпадал с тем, по которому скрипт сэмплов их заливает.
    return {
      lang,
      provider,
      voices: VOICE_CATALOG.filter((v) => v.provider === provider).map((v) => ({
        ...v,
        sampleUrl: this.storage.publicUrl(SPEECH_BUCKET, `speech-samples/${v.id}.mp3`),
      })),
    };
  }

  @Get(':id')
  @UseGuards(JwtGuard)
  async clip(@CurrentUser() user: any, @Param('id') id: string) {
    if (!UUID_RE.test(id)) throw new NotFoundException('clip not found');
    // userId — строго текущий пользователь: getClip фильтрует по нему, иначе
    // по чужому uuid можно было бы вытащить чужую озвучку.
    const clip = await this.speech.getClip(user.userId, id);
    if (!clip) throw new NotFoundException('clip not found');
    return {
      id: clip.id,
      url: clip.url,
      durationSec: Number(clip.duration_sec ?? 0),
      chars: Number(clip.chars),
      voice: clip.voice,
      provider: clip.provider,
      lang: clip.lang,
      createdAt: clip.created_at,
    };
  }
}
