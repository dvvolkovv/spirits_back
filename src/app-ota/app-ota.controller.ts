import { Controller, Get, Post, Body, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Self-hosted OTA-эндпоинт для нативного приложения (@capgo/capacitor-updater).
 *
 * Плагин с autoUpdate:true POST-ит сюда на старте инфо об устройстве и текущей
 * версии веб-бандла. Мы отвечаем { version, url } последнего опубликованного
 * бандла; плагин сам сравнивает версии, скачивает zip, применяет и (directUpdate)
 * перезагружает WebView. Так правки фронта прилетают по воздуху без переустановки.
 *
 * Манифест последнего релиза лежит в public/app-ota/latest.json — его пишет
 * publish-скрипт (scripts/ota-publish.sh) рядом с самим бандлом
 * public/app-ota/<version>.zip (раздаётся nginx-ом как /static/app-ota/...).
 */
@Controller('app-ota')
export class AppOtaController {
  private manifestPath() {
    return path.join(process.cwd(), 'public', 'app-ota', 'latest.json');
  }

  private readManifest(): { version: string; url: string; checksum?: string } | null {
    try {
      const raw = fs.readFileSync(this.manifestPath(), 'utf8');
      const m = JSON.parse(raw);
      if (m && m.version && m.url) return m;
      return null;
    } catch {
      return null;
    }
  }

  // capgo шлёт POST с телом об устройстве/версии; отвечаем последним релизом.
  @Post('latest')
  async latest(@Body() _body: any, @Res() res: Response) {
    const m = this.readManifest();
    if (!m) return res.status(200).json({ message: 'no update available' });
    return res.status(200).json({ version: m.version, url: m.url, ...(m.checksum ? { checksum: m.checksum } : {}) });
  }

  // GET — для ручной проверки текущего опубликованного релиза.
  @Get('latest')
  async latestGet(@Res() res: Response) {
    const m = this.readManifest();
    if (!m) return res.status(200).json({ message: 'no update available' });
    return res.status(200).json(m);
  }
}
