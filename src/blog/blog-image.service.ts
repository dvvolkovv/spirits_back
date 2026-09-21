// src/blog/blog-image.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
import { MiscService } from '../misc/misc.service';
import { renderBannerOverlay } from '../misc/banner-overlay';
import { BlogSettingsService } from './blog-settings.service';

const ASPECT = '1:1';

export function buildBackgroundPrompt(scene: string, style: string): string {
  const styleLine = style.trim() ? `${style.trim()}. ` : '';
  return (
    `${scene}\n\n${styleLine}` +
    `СТРОГО: на изображении НЕ должно быть текста, букв, слов, надписей, цифр, ` +
    `логотипов и водяных знаков. Оставь спокойную область в нижней части кадра ` +
    `под наложение заголовка. ` +
    `No text, no letters, no words, no captions, no watermark, no logo.`
  );
}

@Injectable()
export class BlogImageService {
  private readonly logger = new Logger(BlogImageService.name);

  constructor(
    private readonly misc: MiscService,
    private readonly settings: BlogSettingsService,
  ) {}

  /** Вынесено методом, чтобы тест мог подменить рендер без canvas-зависимостей. */
  protected overlay(bg: Buffer, title: string): Promise<Buffer> {
    return renderBannerOverlay(bg, { title, subtitle: '', cta: '', position: 'bottom', theme: 'dark' });
  }

  /**
   * @returns URL готовой картинки. Генерация может отвалиться тремя разными
   * способами (Google снял Imagen, IMAGE_RECITATION роняет запрос молча,
   * квоты), поэтому после двух попыток рисуем фон сами — канал не должен
   * замолкать из-за чужого сервиса.
   */
  async render(title: string, scene: string): Promise<string> {
    const { imageStyle } = await this.settings.get();

    const attempts = [
      buildBackgroundPrompt(scene, imageStyle),
      buildBackgroundPrompt(scene.split('.')[0] || scene, ''),
    ];

    for (const prompt of attempts) {
      try {
        const { b64Image } = await this.misc.generateRawImage(prompt, ASPECT);
        const banner = await this.overlay(Buffer.from(b64Image, 'base64'), title);
        return await this.misc.uploadAssetImage(banner, 'png');
      } catch (e: any) {
        this.logger.warn(`генерация фона не удалась: ${e.message}`);
      }
    }

    this.logger.warn('фолбэк: рисую фон без модели');
    const banner = await this.overlay(this.flatBackground(), title);
    return await this.misc.uploadAssetImage(banner, 'png');
  }

  /** Фирменный градиент 1024×1024 — не требует ни сети, ни ключей. */
  private flatBackground(): Buffer {
    const size = 1024;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#0f2f24');
    grad.addColorStop(1, '#1f5c45');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return canvas.toBuffer('image/png');
  }
}
