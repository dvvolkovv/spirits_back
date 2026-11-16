import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { publicDir } from '../common/net/own-media';
import {
  DeletionCancelledError,
  DeletionRetryError,
} from '../account-deletion/account-deletion.safe';

const ASSETS_BUCKET = 'linkeon-assets';

/**
 * Формат аватарки по первым байтам файла. Content-Type от клиента не в счёт:
 * им можно назвать картинкой HTML или SVG со скриптом, а мобильное приложение
 * шлёт файл вовсе без типа.
 */
export function sniffAvatarFormat(buf: Buffer): { contentType: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) {
    return { contentType: 'image/gif', ext: 'gif' };
  }
  return null;
}

/** Файл не JPEG/PNG/WebP/GIF — ответ 400, а не 500. */
export class UnsupportedAvatarError extends Error {
  constructor() {
    super('Avatar must be an image: jpeg, png, webp, gif');
  }
}

@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    private readonly pg: PgService,
    private readonly storage: StorageService,
  ) {}

  async getAvatar(userId: string): Promise<{ url: string } | null> {
    // Check profile_data first — holds canonical avatar URL (now a MinIO link).
    const res = await this.pg.query(
      'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const avatarUrl = res.rows[0]?.profile_data?.avatar_url;
    if (avatarUrl) return { url: avatarUrl };

    // Legacy fallback: local file from before the MinIO migration.
    const path = require('path');
    const fs = require('fs');
    const localPath = path.join(process.cwd(), 'public', 'avatars', `${userId}.jpg`);
    if (fs.existsSync(localPath)) {
      return { url: `/static/avatars/${userId}.jpg` };
    }
    return null;
  }

  async uploadAvatar(userId: string, buffer: Buffer): Promise<{ url: string }> {
    const format = sniffAvatarFormat(buffer);
    if (!format) throw new UnsupportedAvatarError();
    const url = await this.storage.upload({
      bucket: ASSETS_BUCKET,
      key: `avatars/users/${userId}.${format.ext}`,
      body: buffer,
      contentType: format.contentType,
      cacheControl: 'public, max-age=2592000',
    });

    await this.pg.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = COALESCE(profile_data, '{}'::jsonb) || $1::jsonb,
           updated_at = now()
       WHERE user_id = $2`,
      [JSON.stringify({ avatar_url: url }), userId],
    );
    return { url };
  }

  async getAgentAvatar(agentId: string): Promise<string | null> {
    // After backfill all agent avatars live in MinIO at the canonical path.
    // Return the URL directly without HEAD/list checks (one extra S3 round-trip
    // per avatar request is too costly when N agents render simultaneously).
    // If the object doesn't exist, MinIO returns 404 and the frontend `<img onError>`
    // handler hides the broken image (see AssistantSelection.tsx).
    return this.storage.publicUrl(ASSETS_BUCKET, `avatars/agents/${agentId}.jpg`);
  }

  // ==================== ACCOUNT DELETION (Task 13) ====================

  /** Безопасный токен userId (телефон или uuid): без '/', traversal и пробелов. */
  private static readonly SAFE_DELETION_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

  /** Расширения, которые sniffAvatarFormat может записать в avatars/users/. */
  private static readonly DELETION_AVATAR_EXTS = ['jpg', 'png', 'webp', 'gif'] as const;

  /**
   * Строгое стирание ПОЛЬЗОВАТЕЛЬСКИХ аватаров при удалении аккаунта.
   *
   * Цели вычисляются из userId, а не читаются из профиля: profile_data.avatar_url
   * НЕ используется как произвольная цель (в нём может лежать чужой или
   * агентский ключ), avatars/agents/ не выбирается никогда — агентские аватары
   * общие. Канонические цели: avatars/users/<userId>.{jpg,png,webp,gif} в
   * MinIO (все четыре расширения — какое занято, знает только бакет) и
   * легаси-файл public/avatars/<userId>.jpg (путь строится только из
   * валидированного userId, с двойной проверкой, что он внутри каталога).
   *
   * Удаление подтверждённое (deleteConfirmed): отсутствие объекта — успех,
   * любой неподтверждённый исход пробрасывается — адаптер account-deletion
   * превратит его в retry. Объекты MinIO — ДО локального файла. Поколение
   * проверяется до первого удаления: аккаунт оживили — DeletionCancelledError.
   */
  async deleteAvatarForDeletion(userId: string, deletionId: string): Promise<void> {
    if (!AvatarService.SAFE_DELETION_USER_RE.test(userId)) {
      throw new DeletionRetryError('db');
    }
    const gen = await this.pg.query(
      `SELECT 1 FROM user_id u
        WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
      [userId, deletionId],
    );
    if ((gen.rowCount ?? 0) === 0) {
      throw new DeletionCancelledError();
    }

    for (const ext of AvatarService.DELETION_AVATAR_EXTS) {
      await this.storage.deleteConfirmed({
        bucket: ASSETS_BUCKET,
        key: `avatars/users/${userId}.${ext}`,
      });
    }

    const avatarsDir = path.join(publicDir(), 'avatars');
    const file = path.join(avatarsDir, `${userId}.jpg`);
    if (!file.startsWith(avatarsDir + path.sep)) {
      throw new DeletionRetryError('db');
    }
    await fs.promises.unlink(file).catch((e: any) => {
      if (e?.code !== 'ENOENT') throw e; // отсутствие файла — подтверждено
    });
  }
}
