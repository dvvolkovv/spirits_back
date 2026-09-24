import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { domainToUnicode } from 'url';
import { PgService } from '../common/services/pg.service';
import { DomainRefusal, normalizeDomain, registrableZone, relativeName } from './domain-name';
import { checkDns, DnsResolver, publicResolver, RecordCheck, TXT_LABEL } from './domain-dns';

export type DomainStatus = 'awaiting_dns' | 'issuing' | 'active' | 'failed' | 'removing';

export interface DomainRecordToSet {
  type: 'TXT' | 'A' | 'CNAME';
  /** Как вводить в панели регистратора — относительно зоны (`@`, `www`, `_linkeon`). */
  name: string;
  fqdn: string;
  value: string;
}

export interface DomainView {
  /** Что привязано — в punycode, как в DNS, в сертификате и в записях ниже. */
  domain: string;
  /** Тот же домен для глаз человека (`пример.рф`); у латинского совпадает с `domain`. */
  domainUnicode: string;
  names: string[];
  status: DomainStatus;
  error: string | null;
  checkedAt: string | null;
  check: RecordCheck[] | null;
  records: DomainRecordToSet[];
}

/**
 * Машинный код причины отказа: по нему кабинет переводит ошибку на язык
 * пользователя; `message` — русский текст для ассистента и запасной.
 */
export type DomainRefusalCode =
  | DomainRefusal // из domain-name: empty, ip, no_dot, bad_form, our_zone, too_long, mixed_script, unknown_tld
  | 'not_found'
  | 'bot'
  | 'blocked'
  | 'not_ready'
  | 'has_domain'
  | 'taken'
  | 'no_domain'
  | 'issuing'
  | 'busy'
  | 'throttled' // «Проверить сейчас» чаще CHECK_THROTTLE_S (задача 5, 429)
  | 'retries'; // больше RETRIES_PER_HOUR повторных выпусков в час (задача 5, 429)

/**
 * Каждый отказ сервиса — с телом `{ statusCode, message, reason }`. Nest
 * отдаёт объект из HttpException клиенту как есть (BaseExceptionFilter), а
 * `e.message` берёт из поля `message` — ассистент читает его же.
 */
const refusal = (status: number, reason: DomainRefusalCode, message: string) =>
  new HttpException({ statusCode: status, message, reason }, status);

/** Фоновая проверка ждущих DNS. */
export const DOMAIN_TICK_MS = 120_000;
/** Сколько суток после заявки фоновая проверка ещё смотрит DNS. Кнопка работает всегда. */
export const PENDING_DAYS = 7;
/** «Проверить сейчас» — не чаще. Это только DNS, Let's Encrypt не трогается. */
export const CHECK_THROTTLE_S = 30;
/** Повторных выпусков после отказа в час. Предел Let's Encrypt — 5 неудач в час на имя. */
export const RETRIES_PER_HOUR = 3;

/**
 * Статусы продукта, при которых домен можно ВЫПУСКАТЬ. Погашенный сюда не
 * входит: гашение бывает и за злоупотребление, и новый домен расширил бы его.
 * Отвязка у погашенного разрешена — она сужает.
 */
const ISSUABLE = ['running', 'degraded', 'sleeping'];
/** Тот же список для SQL (задача 5) — выводится из ISSUABLE, чтобы не разойтись с ним. */
const ISSUABLE_SQL = `(${ISSUABLE.map((s) => `'${s}'`).join(',')})`;

const TAKEN = 'Этот домен уже привязан к другому продукту.';
const BLOCKED = 'Продукт остановлен администратором — привязать домен нельзя.';
const BUSY = 'У продукта сейчас идёт другое задание — отвяжите через минуту.';
export const ORPHAN_ISSUING =
  'Выпуск прерван: задание снято (продукт остановлен или машина не ответила вовремя). Нажмите «Проверить снова».';
export const ORPHAN_REMOVING =
  'Отвязка прервана: задание снято (продукт остановлен или машина не ответила вовремя). Отвяжите домен ещё раз.';

/** Домен в тексте для человека: `пример.рф`, а не `xn--e1afmkfd.xn--p1ai`. */
const readable = (domain: string) => domainToUnicode(domain) || domain;

interface OwnedProduct {
  id: string;
  slug: string;
  kind: string;
  status: string;
  host_ip: string;
  domain_suffix: string;
}

interface DomainRow {
  product_id: string;
  domain: string;
  names: string[];
  token: string;
  status: DomainStatus;
  error: string | null;
  check_result: { records: RecordCheck[] } | null;
  checked_at: string | null;
  attempts: number;
  attempts_since: string;
}

@Injectable()
export class DomainsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DomainsService.name);
  /** Поле, а не аргумент конструктора: Nest внедряет только провайдеры, а тесты подменяют резолвер. */
  private resolver: DnsResolver = publicResolver();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly pg: PgService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.safeTick(), DOMAIN_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Владелец в WHERE, а не проверкой после выборки: «нет такого» и «есть, но
   * не твой» — одна и та же 404, иначе утекает существование чужих продуктов.
   * Адрес машины — из реестра: продукт второй машины получает её IP и её зону.
   */
  private async owned(userId: string, productId: string): Promise<OwnedProduct> {
    const r = await this.pg.query(
      `SELECT p.id, p.slug, p.kind, p.status, host(h.public_ip) AS host_ip, h.domain_suffix
         FROM products p
         JOIN product_hosts h ON h.id = p.host_id
        WHERE p.id = $1 AND p.user_id = $2 AND p.archived_at IS NULL`,
      [productId, userId],
    );
    if (!r.rows[0]) throw refusal(HttpStatus.NOT_FOUND, 'not_found', 'Продукт не найден.');
    return r.rows[0];
  }

  private async rowOf(productId: string): Promise<DomainRow | null> {
    const r = await this.pg.query(`SELECT * FROM product_domains WHERE product_id = $1`, [productId]);
    return r.rows[0] ?? null;
  }

  private recordsFor(row: DomainRow, p: OwnedProduct): DomainRecordToSet[] {
    // Зона — прямым разбором списка суффиксов, не повторной нормализацией:
    // ужесточись правила нормализатора, у уже привязанного поддомена
    // сработала бы запасная ветка, и инструкция молча стала бы `A @` не в той
    // зоне.
    const zone = registrableZone(row.domain);
    const txtFqdn = `${TXT_LABEL}.${row.domain}`;
    const out: DomainRecordToSet[] = [{ type: 'TXT', name: relativeName(txtFqdn, zone), fqdn: txtFqdn, value: row.token }];
    for (const fqdn of row.names) {
      // У корня CNAME запрещён стандартом — только A. Остальные имена — CNAME
      // на адрес продукта: переживёт смену IP машины без правки у регистратора.
      out.push(
        fqdn === zone
          ? { type: 'A', name: '@', fqdn, value: p.host_ip }
          : { type: 'CNAME', name: relativeName(fqdn, zone), fqdn, value: `${p.slug}.${p.domain_suffix}` },
      );
    }
    return out;
  }

  private view(row: DomainRow, p: OwnedProduct): DomainView {
    return {
      domain: row.domain,
      domainUnicode: readable(row.domain),
      names: row.names,
      status: row.status,
      error: row.error,
      checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
      check: row.check_result?.records ?? null,
      records: this.recordsFor(row, p),
    };
  }

  async get(userId: string, productId: string): Promise<DomainView | null> {
    const p = await this.owned(userId, productId);
    const row = await this.rowOf(productId);
    return row ? this.view(row, p) : null;
  }

  async attach(userId: string, productId: string, raw: unknown): Promise<DomainView> {
    const n = normalizeDomain(raw);
    // `=== false`, а не `!n.ok`: при выключенном strictNullChecks отрицание
    // не сужает союз, и n.reason / n.say не компилируются.
    if (n.ok === false) throw refusal(HttpStatus.UNPROCESSABLE_ENTITY, n.reason, n.say);

    const p = await this.owned(userId, productId);
    if (p.kind !== 'site') {
      throw refusal(HttpStatus.CONFLICT, 'bot', 'У бота нет адреса — свой домен бывает только у сайта.');
    }
    if (p.status === 'blocked') throw refusal(HttpStatus.CONFLICT, 'blocked', BLOCKED);
    if (!ISSUABLE.includes(p.status)) {
      throw refusal(HttpStatus.CONFLICT, 'not_ready', 'Продукт ещё не заведён — привязать домен можно, когда он заработает.');
    }

    const existing = await this.rowOf(productId);
    if (existing) {
      if (existing.domain === n.domain) return this.view(existing, p);
      throw this.hasDomain(existing);
    }

    const busy = await this.pg.query(
      `SELECT 1 FROM product_domains
        WHERE domain = $1 AND status IN ('issuing','active','removing') AND product_id <> $2`,
      [n.domain, productId],
    );
    if (busy.rows.length) throw refusal(HttpStatus.CONFLICT, 'taken', TAKEN);

    const token = `lk-${crypto.randomBytes(16).toString('hex')}`;
    const ins = await this.pg.query(
      `INSERT INTO product_domains (product_id, domain, names, token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id) DO NOTHING
       RETURNING *`,
      [productId, n.domain, n.names, token],
    );

    // Пусто — строку продукта успела завести параллельная привязка: её домен
    // может быть и другим.
    const row: DomainRow | null = ins.rows[0] ?? (await this.rowOf(productId));
    if (!row) {
      // ...а параллельная отвязка — уже снять её.
      throw refusal(HttpStatus.CONFLICT, 'busy', 'Заявку на домен в ту же секунду сняли — привяжите домен ещё раз.');
    }
    if (row.domain !== n.domain) throw this.hasDomain(row);
    return this.view(await this.runCheck(row, p), p);
  }

  private hasDomain(row: DomainRow) {
    return refusal(
      HttpStatus.CONFLICT,
      'has_domain',
      `У продукта уже есть свой домен ${readable(row.domain)} — сначала отвяжите его.`,
    );
  }

  async detach(userId: string, productId: string): Promise<{ removed: 'now' | 'queued' }> {
    await this.owned(userId, productId);
    let row = await this.rowOf(productId);
    if (!row) throw refusal(HttpStatus.NOT_FOUND, 'no_domain', 'У продукта нет своего домена.');

    if (row.status === 'awaiting_dns') {
      const del = await this.pg.query(
        `DELETE FROM product_domains WHERE product_id = $1 AND status = 'awaiting_dns'`,
        [productId],
      );
      if (del.rowCount === 1) return { removed: 'now' };
      // Между чтением и удалением заявку увела фоновая проверка — в выпуск.
      // Ответить «удалено» значило бы соврать: сертификат выпустится, и домен
      // всплывёт работающим. Решаем по свежему состоянию.
      row = await this.rowOf(productId);
      if (!row) return { removed: 'now' };
    }
    if (row.status === 'issuing') {
      throw refusal(
        HttpStatus.CONFLICT,
        'issuing',
        'Идёт выпуск сертификата — отвязать можно, когда он закончится (обычно меньше минуты).',
      );
    }
    if (row.status === 'removing') return { removed: 'queued' };

    try {
      const r = await this.pg.query(
        `WITH d AS (
            UPDATE product_domains SET status = 'removing', error = NULL
             WHERE product_id = $1 AND status IN ('active','failed')
               AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                                WHERE j.product_id = $1 AND j.status IN ('queued','running'))
            RETURNING product_id
         ), q AS (
            INSERT INTO product_provision_jobs (product_id, kind, status)
            SELECT product_id, 'domain', 'queued' FROM d
            RETURNING product_id
         )
         SELECT (SELECT count(*) FROM q)::int AS queued`,
        [productId],
      );
      if (r.rows[0].queued === 1) return { removed: 'queued' };
    } catch (e: any) {
      if (e?.code !== '23505') throw e;
      if (e.constraint === 'product_domains_occupied') {
        // Домен держит другой продукт: эта заявка до машины не доходила.
        const del = await this.pg.query(
          `DELETE FROM product_domains WHERE product_id = $1 AND status = 'failed'`,
          [productId],
        );
        if (del.rowCount === 1) return { removed: 'now' };
      }
      // Остальное 23505 — единственное активное задание продукта
      // (product_provision_jobs_one_active): сон или пробуждение встали
      // мимо NOT EXISTS, оператор откатился целиком, строка не тронута.
    }
    throw refusal(HttpStatus.CONFLICT, 'busy', BUSY);
  }

  /**
   * Проверка DNS и сохранение результата. Ошибку Let's Encrypt (`error`) не
   * трогает. Если строку за время проверки отвязали, отдаёт ту, что была:
   * привязка случилась раньше отвязки.
   */
  private async runCheck(row: DomainRow, p: OwnedProduct): Promise<DomainRow> {
    const result = await checkDns({ domain: row.domain, names: row.names, token: row.token, hostIp: p.host_ip }, this.resolver);
    await this.pg.query(
      `UPDATE product_domains SET check_result = $2::jsonb, checked_at = now() WHERE product_id = $1`,
      [row.product_id, JSON.stringify({ records: result.records })],
    );
    if (result.ok) await this.tryIssue(row.product_id);
    return (await this.rowOf(row.product_id)) ?? row;
  }

  // Задача 5 заменяет обе заглушки и добавляет check, checkPending, reconcileOrphans.
  async tryIssue(_productId: string): Promise<'queued' | 'busy' | 'taken' | 'refused' | 'none'> {
    return 'none';
  }

  private async safeTick() {
    /* задача 5 */
  }
}
