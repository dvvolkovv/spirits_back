import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { decryptSecret, encryptSecret } from '../calendar/crypto';

/**
 * Хранилище подключений Zoom: одна строка на пользователя, токены шифрованные.
 *
 * Устроено как `TalerIdStoreService` — тот же приём с миграцией при старте и
 * тем же шифрованием (AES-256-GCM, `CALENDAR_SECRET_KEY`). Держать секреты
 * чужого аккаунта в открытом виде нельзя: по ним заходят в чужие встречи.
 */

export interface ZoomConnection {
  userId: string;
  zoomUserId: string | null;
  zoomAccountId: string | null;
  refreshToken: string | null;
  accessToken: string | null;
  accessExpiresAt: Date | null;
  scopes: string | null;
}

@Injectable()
export class ZoomStoreService implements OnModuleInit {
  private readonly logger = new Logger(ZoomStoreService.name);

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit(): Promise<void> {
    if (!this.pg) return;
    // Тот же порядок поиска, что у Taler ID: рядом со сборкой и в исходниках —
    // чтобы работало и из dist, и из ts-node в тестах.
    const candidates = [
      path.join(__dirname, 'migrations', '001_zoom.sql'),
      path.join(__dirname, '..', '..', 'src', 'zoom', 'migrations', '001_zoom.sql'),
    ];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        await this.pg.query(fs.readFileSync(p, 'utf8'));
        return;
      } catch (e: any) {
        this.logger.warn(`миграция Zoom не применилась: ${e?.message}`);
        return;
      }
    }
  }

  async get(userId: string): Promise<ZoomConnection | null> {
    if (!this.pg) return null;
    const r = await this.pg.query(`SELECT * FROM zoom_connections WHERE user_id = $1`, [userId]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      zoomUserId: row.zoom_user_id ?? null,
      zoomAccountId: row.zoom_account_id ?? null,
      refreshToken: row.refresh_token_enc ? safeDecrypt(row.refresh_token_enc) : null,
      accessToken: row.access_token_enc ? safeDecrypt(row.access_token_enc) : null,
      accessExpiresAt: row.access_expires_at ? new Date(row.access_expires_at) : null,
      scopes: row.scopes ?? null,
    };
  }

  /**
   * Сохранить подключение целиком.
   *
   * Именно целиком, а не по полям: refresh у Zoom ротируется, и запись, где
   * новый access лёг рядом со старым refresh, обрекает следующее обновление на
   * отказ.
   */
  async save(c: {
    userId: string;
    zoomUserId?: string | null;
    zoomAccountId?: string | null;
    refreshToken: string;
    accessToken: string;
    accessExpiresAt: Date;
    scopes?: string | null;
  }): Promise<void> {
    if (!this.pg) return;
    await this.pg.query(
      `INSERT INTO zoom_connections
         (user_id, zoom_user_id, zoom_account_id, refresh_token_enc, access_token_enc, access_expires_at, scopes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET
         zoom_user_id = EXCLUDED.zoom_user_id,
         zoom_account_id = EXCLUDED.zoom_account_id,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         access_token_enc = EXCLUDED.access_token_enc,
         access_expires_at = EXCLUDED.access_expires_at,
         scopes = EXCLUDED.scopes,
         updated_at = now()`,
      [
        c.userId,
        c.zoomUserId ?? null,
        c.zoomAccountId ?? null,
        encryptSecret(c.refreshToken),
        encryptSecret(c.accessToken),
        c.accessExpiresAt,
        c.scopes ?? null,
      ],
    );
  }

  async remove(userId: string): Promise<void> {
    if (!this.pg) return;
    await this.pg.query(`DELETE FROM zoom_connections WHERE user_id = $1`, [userId]);
  }
}

/**
 * Расшифровка, которая не роняет запрос.
 *
 * Ключ шифрования мог смениться, а строка остаться. Это не повод отдавать 500
 * на «покажи состояние подключения»: пусть выглядит как отсутствующее, и
 * человек подключит аккаунт заново.
 */
function safeDecrypt(enc: string): string | null {
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}
