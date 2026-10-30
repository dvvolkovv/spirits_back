import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { DEFAULT_GUEST_LIMITS, GuestLimits, GuestMode, parseLimitsPatch, parseMode, sanitizeLimits } from './guest-trial.types';

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
  /** Поколение записи: settings() кладёт прочитанное в кэш только если за время
   *  чтения не случилось параллельной записи — иначе можно закэшировать то,
   *  что уже устарело к моменту завершения чтения. */
  private generation = 0;
  /** Чтобы «мусор в лимитах» и «неизвестный режим» не писались в лог на
   *  каждое обновление кэша (раз в 15 с), а только когда набор изменился. */
  private lastWarnSignature: string | null = null;

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
        this.log.log(`guest-trial migration ${file} applied`);
      } catch (e: any) {
        this.log.error(`guest-trial migration ${file} failed: ${e.message}`);
      }
    }
  }

  async settings(): Promise<GuestSettings> {
    if (this.cache && Date.now() - this.cache.at < SETTINGS_CACHE_MS) return this.cache.value;
    const genAtStart = this.generation;
    const r = await this.pg.query(`SELECT key, value FROM guest_trial_settings WHERE key IN ('mode', 'limits')`);
    const byKey = new Map<string, unknown>(r.rows.map((row: any) => [row.key, row.value]));
    const { limits, ignored } = sanitizeLimits(byKey.get('limits'));
    const modeRaw = byKey.get('mode');
    const mode = parseMode(modeRaw);
    const modeUnknown = modeRaw !== undefined && modeRaw !== 'off' && mode === 'off';
    this.warnOnChange(ignored, modeUnknown, modeRaw);
    const value: GuestSettings = { mode, limits: Object.freeze(limits) };
    Object.freeze(value);
    if (this.generation === genAtStart) this.cache = { at: Date.now(), value };
    return value;
  }

  async setMode(mode: GuestMode): Promise<void> {
    await this.upsert('mode', mode);
  }

  /**
   * Патч лимитов хранится в строке 'limits' ТОЛЬКО как переопределения и
   * сливается в базе атомарно (jsonb ||), а не read-modify-write в коде: два
   * параллельных вызова с разными ключами не затирают изменения друг друга.
   * Действующие лимиты = DEFAULT_GUEST_LIMITS поверх этой строки.
   */
  async setLimits(raw: unknown): Promise<{ limits: GuestLimits; ignored: string[]; changed: boolean }> {
    const { patch, ignored } = parseLimitsPatch(raw);
    if (Object.keys(patch).length === 0) {
      return { limits: (await this.settings()).limits, ignored, changed: false };
    }
    const r = await this.pg.query(
      `INSERT INTO guest_trial_settings (key, value) VALUES ('limits', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = guest_trial_settings.value || EXCLUDED.value, updated_at = now()
       RETURNING value`,
      [JSON.stringify(patch)],
    );
    this.bumpGeneration();
    const limits = Object.freeze(sanitizeLimits(r.rows[0].value, DEFAULT_GUEST_LIMITS).limits);
    return { limits, ignored, changed: true };
  }

  /** Лог «что не так» только при смене сигнатуры — не на каждый перечит кэша. */
  private warnOnChange(ignored: string[], modeUnknown: boolean, modeRaw: unknown): void {
    const signature = `${ignored.join(',')}|${modeUnknown ? String(modeRaw) : ''}`;
    if (signature === this.lastWarnSignature) return;
    this.lastWarnSignature = signature;
    if (ignored.length) this.log.warn(`guest_trial_settings.limits: пропущены ${ignored.join(', ')}`);
    if (modeUnknown) this.log.warn(`guest_trial_settings.mode: неизвестное значение ${String(modeRaw)}`);
  }

  private async upsert(key: string, value: unknown): Promise<void> {
    await this.pg.query(
      `INSERT INTO guest_trial_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    this.bumpGeneration();
  }

  private bumpGeneration(): void {
    this.generation++;
    this.cache = null;
  }
}
