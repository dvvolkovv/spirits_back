import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { GuestLimits, GuestMode, parseMode, sanitizeLimits } from './guest-trial.types';

export const GUEST_TRIAL_MIGRATIONS = ['001_guest_trial.sql'];

/** Режим и лимиты читаются на каждом ходе гостя и на каждом открытии кабинета без входа. */
const SETTINGS_CACHE_MS = 15_000;

export interface GuestSettings {
  mode: GuestMode;
  limits: GuestLimits;
}

@Injectable()
export class GuestTrialStore implements OnModuleInit {
  private readonly log = new Logger('GuestTrialStore');
  private cache: { at: number; value: GuestSettings } | null = null;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    for (const file of GUEST_TRIAL_MIGRATIONS) {
      // .sql в dist не копируется (nest-cli.json без assets): на проде
      // работает второй путь, через src. Не удалять его как «dev-фолбэк».
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'guest-trial', 'migrations', file),
      ];
      const p = candidates.find((c) => fs.existsSync(c));
      if (!p) {
        this.log.error(`guest-trial migration ${file} not found`);
        continue;
      }
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
      } catch (e: any) {
        this.log.error(`guest-trial migration ${file} failed: ${e.message}`);
      }
    }
  }

  async settings(): Promise<GuestSettings> {
    if (this.cache && Date.now() - this.cache.at < SETTINGS_CACHE_MS) return this.cache.value;
    const r = await this.pg.query(`SELECT key, value FROM guest_trial_settings WHERE key IN ('mode', 'limits')`);
    const byKey = new Map<string, unknown>(r.rows.map((row: any) => [row.key, row.value]));
    const { limits, ignored } = sanitizeLimits(byKey.get('limits'));
    if (ignored.length) this.log.warn(`guest_trial_settings.limits: пропущены ${ignored.join(', ')}`);
    const value: GuestSettings = { mode: parseMode(byKey.get('mode')), limits };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async setMode(mode: GuestMode): Promise<void> {
    await this.upsert('mode', mode);
  }

  /** Правка лимитов поверх текущих; мусор не пишется и возвращается в ignored. */
  async setLimits(patch: unknown): Promise<{ limits: GuestLimits; ignored: string[] }> {
    const current = (await this.settings()).limits;
    const next = sanitizeLimits(patch, current);
    await this.upsert('limits', next.limits);
    return next;
  }

  private async upsert(key: string, value: unknown): Promise<void> {
    await this.pg.query(
      `INSERT INTO guest_trial_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    this.cache = null;
  }
}
