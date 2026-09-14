import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

/**
 * Интеграции, которые можно включать по отдельности.
 *
 * Список держим здесь, а не собираем из базы: админке нужно показать
 * переключатель и для того, что ещё ни разу не включали, а такой строки в
 * таблице может не быть вовсе.
 */
export const INTEGRATIONS = [
  { key: 'meeting:talerid', title: 'Встречи Taler ID', note: 'Вход в чужую комнату Taler ID по ссылке', available: true },
  { key: 'meeting:meet', title: 'Встречи Google Meet', note: 'Вход ботом через мост Attendee', available: true },
  { key: 'meeting:zoom', title: 'Встречи Zoom', note: 'Вход ботом через мост Attendee, веб-адаптер', available: true },
  {
    key: 'meeting:teams',
    title: 'Встречи Microsoft Teams',
    note: 'Вход ботом через мост Attendee: личные и корпоративные ссылки',
    available: true,
  },
] as const;

export type IntegrationKey = (typeof INTEGRATIONS)[number]['key'];

export interface IntegrationFlag {
  key: string;
  title: string;
  note: string;
  /** Разведена ли интеграция в продукте. Недоступную нельзя включить. */
  available: boolean;
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Насколько живёт снимок флагов.
 *
 * Ноль означал бы запрос в базу на КАЖДОЕ сообщение чата — распознавание
 * ссылки на встречу живёт ровно там. Десять секунд — компромисс: переключение
 * в админке видно почти сразу, а нагрузки не создаёт.
 */
const CACHE_TTL_MS = 10_000;

/**
 * Выключатели интеграций.
 *
 * ПРАВИЛО ПО УМОЛЧАНИЮ: нет строки — выключено. Из него следует главное
 * свойство: новая интеграция, приехавшая с выкаткой кода, сама не включается.
 * Оно же работает и при недоступной базе — см. `enabled()`.
 */
@Injectable()
export class IntegrationFlagsService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationFlagsService.name);
  private cache: Map<string, boolean> | null = null;
  private cachedAt = 0;

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    // Миграции модуля — тем же способом, что в остальных модулях: из dist и
    // из исходников, идемпотентно.
    for (const base of [
      path.join(__dirname, 'migrations'),
      path.join(__dirname, '..', '..', 'src', 'integrations', 'migrations'),
    ]) {
      try {
        if (!fs.existsSync(base)) continue;
        const files = fs.readdirSync(base).filter((f) => f.endsWith('.sql')).sort();
        for (const f of files) {
          try {
            await this.pg.query(fs.readFileSync(path.join(base, f), 'utf8'));
            this.logger.log(`integration flags migration applied: ${f}`);
          } catch (e: any) {
            this.logger.error(`integration flags migration failed (${f}): ${e.message}`);
          }
        }
        break;
      } catch (e: any) {
        this.logger.error(`integration flags migrations dir failed (${base}): ${e.message}`);
      }
    }
  }

  /**
   * Включена ли интеграция.
   *
   * Сбой базы — это «выключено», а не исключение: вызывающие решают, показать
   * ли карточку и пускать ли во встречу, и падать там нельзя. Молча включить
   * при сбое было бы хуже всего: ровно от этого таблица и заводилась.
   */
  async enabled(key: string): Promise<boolean> {
    // Неразведённая интеграция выключена всегда, что бы ни лежало в базе.
    const known = INTEGRATIONS.find((i) => i.key === key);
    if (known && !known.available) return false;
    try {
      const flags = await this.all();
      return flags.get(key) === true;
    } catch (e: any) {
      this.logger.error(`flags read failed (${key}): ${e.message}`);
      return false;
    }
  }

  /** Снимок всех флагов для админки — вместе с теми, чего в базе ещё нет. */
  async list(): Promise<IntegrationFlag[]> {
    const res = await this.pg.query(
      `SELECT key, enabled, updated_at, updated_by FROM integration_flags`,
    );
    const rows = new Map<string, any>(res.rows.map((r: any) => [r.key, r]));
    return INTEGRATIONS.map((i) => {
      const row = rows.get(i.key);
      return {
        key: i.key,
        title: i.title,
        note: i.note,
        available: i.available,
        // Недоступная интеграция показывается выключенной независимо от
        // того, что лежит в базе: включить её мог кто-то до этой правки.
        enabled: i.available && row?.enabled === true,
        updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : undefined,
        updatedBy: row?.updated_by || undefined,
      };
    });
  }

  /**
   * Переключить интеграцию.
   *
   * Ключ сверяется со списком: опечатка в запросе иначе завела бы строку,
   * которую никто никогда не прочитает, и выглядело бы это как «включил, а не
   * работает».
   */
  async set(key: string, enabled: boolean, actor?: string): Promise<IntegrationFlag[]> {
    const known = INTEGRATIONS.find((i) => i.key === key);
    if (!known) throw new Error(`unknown integration: ${key}`);
    if (!known.available && enabled) {
      throw new Error(`integration is not implemented yet: ${key}`);
    }
    await this.pg.query(
      `INSERT INTO integration_flags (key, enabled, updated_at, updated_by)
            VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE
            SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, enabled, actor || null],
    );
    // Свой же снимок сбрасываем сразу: админ жмёт переключатель и тут же идёт
    // проверять, а ждать десять секунд в этот момент невыносимо.
    this.cache = null;
    this.logger.log(`integration ${key} → ${enabled ? 'включена' : 'выключена'}${actor ? ` (${actor})` : ''}`);
    return this.list();
  }

  /** Снимок из базы с коротким сроком жизни. */
  private async all(): Promise<Map<string, boolean>> {
    if (this.cache && Date.now() - this.cachedAt < CACHE_TTL_MS) return this.cache;
    const res = await this.pg.query(`SELECT key, enabled FROM integration_flags`);
    const map = new Map<string, boolean>();
    for (const r of res.rows as any[]) map.set(String(r.key), r.enabled === true);
    this.cache = map;
    this.cachedAt = Date.now();
    return map;
  }
}
