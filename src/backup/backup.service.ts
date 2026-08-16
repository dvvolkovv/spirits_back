import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { ParsedUpload } from './backup.util';

export interface BackupMeta {
  size: number;
  format: number;
  updatedAt: string;
  hasPrevious: boolean;
}

export interface BackupBlob {
  blob: string; // base64
  size: number;
  format: number;
  updatedAt: string;
}

/**
 * Слепое хранилище зашифрованной копии профиля (A6, §4.2.1). Кладём/отдаём непрозрачный
 * шифротекст по user_id и НИКОГДА его не разбираем — ключа у нас нет. Держим текущую и одну
 * предыдущую копию: битая/пустая загрузка не должна стереть единственную хорошую (не теряем данные).
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    // Каждый модуль накатывает свои .sql сам (глобального раннера нет) — как ProfileService.
    for (const file of ['001_profile_backups.sql']) {
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'backup', 'migrations', file),
      ];
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            await this.pg.query(fs.readFileSync(p, 'utf8'));
            this.logger.log(`backup migration ${file} applied from ${p}`);
            break;
          }
        } catch (e: any) {
          this.logger.error(`backup migration ${file} failed (${p}): ${e.message}`);
        }
      }
    }
  }

  /** Сохранить копию. Текущая уезжает в prev_*, новая становится текущей. */
  async put(userId: string, up: ParsedUpload): Promise<BackupMeta> {
    const res = await this.pg.query(
      `INSERT INTO profile_backups (user_id, blob, size_bytes, format, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET
         prev_blob       = profile_backups.blob,
         prev_size_bytes = profile_backups.size_bytes,
         prev_updated_at = profile_backups.updated_at,
         blob            = EXCLUDED.blob,
         size_bytes      = EXCLUDED.size_bytes,
         format          = EXCLUDED.format,
         updated_at      = now()
       RETURNING size_bytes, format, updated_at, prev_updated_at`,
      [userId, up.bytes, up.size, up.format],
    );
    return this.toMeta(res.rows[0]);
  }

  /** Отдать текущую (или предыдущую) копию как base64. null — если её нет. */
  async get(userId: string, previous = false): Promise<BackupBlob | null> {
    const cols = previous
      ? 'prev_blob AS blob, prev_size_bytes AS size_bytes, prev_updated_at AS updated_at, format'
      : 'blob, size_bytes, format, updated_at';
    const res = await this.pg.query(
      `SELECT ${cols} FROM profile_backups WHERE user_id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row || !row.blob) {
      return null;
    }
    return {
      blob: Buffer.from(row.blob).toString('base64'),
      size: row.size_bytes,
      format: row.format,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  /** Метаданные без переноса самого блоба — устройству проверить, есть ли копия и когда. */
  async meta(userId: string): Promise<BackupMeta | null> {
    const res = await this.pg.query(
      `SELECT size_bytes, format, updated_at, prev_updated_at
       FROM profile_backups WHERE user_id = $1`,
      [userId],
    );
    return res.rows[0] ? this.toMeta(res.rows[0]) : null;
  }

  /** Стереть серверную копию — суверенное право владельца отозвать её (§4.2.1). */
  async remove(userId: string): Promise<boolean> {
    const res = await this.pg.query(
      'DELETE FROM profile_backups WHERE user_id = $1',
      [userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private toMeta(row: any): BackupMeta {
    return {
      size: row.size_bytes,
      format: row.format,
      updatedAt: new Date(row.updated_at).toISOString(),
      hasPrevious: row.prev_updated_at != null,
    };
  }
}
