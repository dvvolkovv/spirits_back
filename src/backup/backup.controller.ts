import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { BackupService } from './backup.service';
import { BackupValidationError, parseBackupUpload } from './backup.util';

/**
 * Слепое хранилище зашифрованной копии профиля (A6, §4.2.1). global prefix 'webhook' →
 * /webhook/backup/*. Сервер только кладёт/отдаёт непрозрачный шифротекст — не расшифровывает.
 */
@Controller('backup')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  /** Загрузить копию. Тело: { blob: base64, format?: number }. */
  @Post()
  @UseGuards(JwtGuard)
  async upload(@CurrentUser() user: any, @Body() body: any) {
    let parsed;
    try {
      parsed = parseBackupUpload(body);
    } catch (e) {
      if (e instanceof BackupValidationError) {
        return { ok: false, error: e.message };
      }
      throw e;
    }
    const meta = await this.backup.put(String(user.userId), parsed);
    return { ok: true, ...meta };
  }

  /** Скачать текущую копию (?previous=1 — предыдущую). */
  @Get()
  @UseGuards(JwtGuard)
  async download(@CurrentUser() user: any, @Query('previous') previous?: string) {
    const blob = await this.backup.get(String(user.userId), previous === '1' || previous === 'true');
    if (!blob) {
      return { exists: false };
    }
    return { exists: true, ...blob };
  }

  /** Метаданные копии без переноса блоба. */
  @Get('meta')
  @UseGuards(JwtGuard)
  async meta(@CurrentUser() user: any) {
    const meta = await this.backup.meta(String(user.userId));
    return meta ? { exists: true, ...meta } : { exists: false };
  }

  /** Отозвать серверную копию (суверенное право владельца). */
  @Delete()
  @UseGuards(JwtGuard)
  async remove(@CurrentUser() user: any) {
    const removed = await this.backup.remove(String(user.userId));
    return { ok: true, removed };
  }
}
