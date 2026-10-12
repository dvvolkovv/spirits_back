import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { StorageService } from '../../common/services/storage.service';
import { ThumbnailService } from './thumbnail.service';
import { encodeKeyPath, parseThumbSrc } from './thumbnails';

/**
 * Миниатюра картинки для панели «Медиа и файлы». Без входа: `<img>` не умеет
 * слать токен, а исходники и так открыты по точной ссылке. При любом сбое —
 * редирект на оригинал: плитка покажет картинку как раньше, только тяжелее.
 */
@Controller('chat/thumb')
export class ChatThumbController {
  private readonly logger = new Logger(ChatThumbController.name);

  constructor(
    private readonly thumbs: ThumbnailService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async thumb(@Query('src') raw: string | undefined, @Res() res: Response) {
    const src = parseThumbSrc(raw);
    if (!src) return res.status(400).json({ error: 'bad src' });
    try {
      const location = await this.thumbs.resolve(src);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, location);
    } catch (e: any) {
      this.logger.warn(`thumb: отдаю оригинал ${src.bucket}/${src.key}: ${e?.message || e}`);
      // Без кеша: следующий показ попробует миниатюру снова.
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, this.storage.publicUrl(src.bucket, encodeKeyPath(src.key)));
    }
  }
}
