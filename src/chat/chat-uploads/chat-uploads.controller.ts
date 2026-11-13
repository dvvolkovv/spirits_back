import { Controller, Get, Logger, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtService } from '../../common/services/jwt.service';
import { contentDispositionFor } from '../chat-files/file-meta';
import { ChatUploadsService } from './chat-uploads.service';

/**
 * Приватное скачивание исходников загрузок: владелец — по JWT, ассистент —
 * по короткоживущей подписи exp+sig. Решение «владелец ИЛИ подпись» и
 * единый 404 без раскрытия существования записи живут в сервисе
 * (openDownload); контроллер лишь разбирает доступ и стримит байты.
 */
@Controller('chat-uploads')
export class ChatUploadsController {
  private readonly logger = new Logger(ChatUploadsController.name);

  constructor(
    private readonly uploads: ChatUploadsService,
    private readonly jwt: JwtService,
  ) {}

  @Get(':id')
  async download(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    let userId: string | undefined;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      try {
        const payload = this.jwt.verifyAccess(auth.slice(7));
        userId = payload?.sub || payload?.userId;
      } catch {
        // Невалидный токен — анонимный запрос: доступ тогда решает подпись.
      }
    }
    const file = await this.uploads.openDownload({
      id,
      userId,
      exp: req.query.exp as string | undefined,
      sig: req.query.sig as string | undefined,
    });

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDispositionFor(file.originalName));
    // Ошибка потока после начала ответа (MinIO оборвал соединение) не должна
    // вешать процесс: уничтожаем ответ и логируем вид ошибки, без байтов.
    file.body.on('error', (e: any) => {
      this.logger.error(
        `download ${id}: stream failed: ${e?.name || 'Error'}: ${String(e?.message ?? '').slice(0, 200)}`,
      );
      res.destroy();
    });
    file.body.pipe(res);
  }
}
