import {
  BadGatewayException,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtService } from '../../common/services/jwt.service';
import { contentDispositionFor } from '../chat-files/file-meta';
import { ChatUploadDeleteError, ChatUploadsService } from './chat-uploads.service';
import type { ChatUploadDownload } from './chat-uploads.service';
import { errKind, logId } from './err-kind';

/**
 * Приватные загрузки пользователя.
 *
 * GET :id — скачивание исходника: владелец по JWT, ассистент по короткоживущей
 * подписи exp+sig. Решение «владелец ИЛИ подпись» и единый 404 без раскрытия
 * существования записи живут в сервисе (openDownload); контроллер лишь
 * разбирает доступ и стримит байты. Без sig и без валидного access-токена —
 * 401 до сервиса, как у thumb и DELETE: фронт обновит токен и повторит, а не
 * покажет «файла нет». 401 зависит только от авторизации, не от id.
 *
 * GET :id/thumb и DELETE :id — только владелец по JWT (спека
 * 2026-11-16-chat-uploads-media-notes-design.md): миниатюра нужна панели
 * кабинета, удаляет только сам пользователь, ассистент — никогда. Подпись
 * exp/sig здесь не принимается вовсе: без валидного access-токена — 401 (фронт
 * обновит токен и повторит запрос), сервис даже не вызывается. Чужой или
 * несуществующий id с валидным токеном — 404 без раскрытия существования.
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
    const userId = this.ownerFrom(req);
    const sig = req.query.sig;
    // Подписи нет — доступ даёт только access-токен владельца. С подписью
    // (даже неверной) решает сервис, как раньше: там единый 404.
    if (!userId && (sig === undefined || sig === '')) throw new UnauthorizedException();
    const file = await this.uploads.openDownload({
      id,
      userId,
      exp: req.query.exp as string | undefined,
      sig: sig as string | undefined,
    });

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDispositionFor(file.originalName));
    this.streamTo(`download (id=${logId(id)})`, file, res);
  }

  @Get(':id/thumb')
  async thumb(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.ownerFrom(req);
    if (!userId) throw new UnauthorizedException();
    const file = await this.uploads.openThumb({ id, userId });

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // inline: панель кладёт ответ в <img> через blob, а не скачивает файл.
    res.setHeader('Content-Disposition', 'inline');
    this.streamTo(`thumb (id=${logId(id)})`, file, res);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const userId = this.ownerFrom(req);
    if (!userId) throw new UnauthorizedException();
    try {
      await this.uploads.deleteForOwner({ id, userId });
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      // MinIO не подтвердил удаление: строка цела, повтор безопасен. 502, а не
      // 404 — фронт должен показать «не удалось удалить», а не «файла нет».
      if (e instanceof ChatUploadDeleteError) {
        throw new BadGatewayException('Upload storage unavailable');
      }
      // Прочее (pg и т. п.) — 500, но журнал свой: сообщение pg/S3 может
      // повторять ключ `<uuid>/<имя файла>`, а ExceptionsHandler Nest написал
      // бы его вместе со стеком. HttpException он не журналирует.
      this.logger.error(`delete (id=${logId(id)}): internal failure: ${errKind(e)}`);
      throw new InternalServerErrorException();
    }
  }

  /**
   * Владелец из Bearer access-токена. Нет токена, мусор, refresh-токен или
   * токен инструмента продуктов (verifyAccess) — undefined.
   */
  private ownerFrom(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return undefined;
    try {
      const payload = this.jwt.verifyAccess(auth.slice(7));
      return payload?.sub || payload?.userId;
    } catch {
      // Невалидный токен — анонимный запрос: для GET :id с подписью доступ
      // тогда решает подпись, без подписи и для thumb и DELETE это 401.
      return undefined;
    }
  }

  private streamTo(label: string, file: ChatUploadDownload, res: Response): void {
    // Клиент ушёл, пока сервис ходил в MinIO: 'close' ответа уже был и больше
    // не придёт, а pipe в уничтоженный ответ стрим источника не закроет —
    // сокет GetObject висел бы до серверного таймаута.
    if (res.destroyed || res.writableEnded) {
      file.body.destroy();
      return;
    }
    // Ошибка потока после начала ответа (MinIO оборвал соединение) не должна
    // вешать процесс: уничтожаем ответ и логируем только вид ошибки — текст
    // сообщения S3 может повторять ключ объекта с именем файла.
    file.body.on('error', (e: any) => {
      this.logger.error(`${label}: stream failed: ${errKind(e)}`);
      res.destroy();
    });
    // Обрыв клиента: pipe делает только unpipe, а S3-стрим (HTTP-ответ
    // GetObject от MinIO) остаётся живым и paused, сокет держится до
    // серверного таймаута — утечка fd при регулярных обрывах скачиваний.
    // destroy() уже завершившегося стрима безопасен (образец —
    // mcp.controller.ts, products.controller.ts).
    res.on('close', () => file.body.destroy());
    file.body.pipe(res);
  }
}
