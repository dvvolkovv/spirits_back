import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { PgService } from '../common/services/pg.service';
import {
  AGENT_OUTDATED_MARKER,
  DomainRefusal,
  normalizeDomain,
  readableDomain,
  registrableZone,
  relativeName,
} from './domain-name';
import { checkDns, DnsResolver, probeResolver, publicResolver, RecordCheck, TXT_LABEL } from './domain-dns';

export type DomainStatus = 'awaiting_dns' | 'issuing' | 'active' | 'failed' | 'removing';

/**
 * Машинный код причины `error` (колонка error_reason, словарь закрыт в 008):
 * taken — домен занял другой продукт; orphan_* — задание выпуска или отвязки
 * сняли снаружи; issue_failed / remove_failed — отказ, о котором отчитался
 * агент (их пишет приём отчёта, задача 6); agent_outdated — агент машины
 * старее сервера и задания domain не знает (см. AGENT_OUTDATED_MARKER в
 * domain-name.ts).
 */
export type DomainErrorReason =
  | 'taken'
  | 'orphan_issuing'
  | 'orphan_removing'
  | 'issue_failed'
  | 'remove_failed'
  | 'agent_outdated';

/**
 * Маркер отказа устаревшего агента (см. AGENT_OUTDATED_MARKER в domain-name.ts)
 * как SQL-шаблон LIKE: в нём нет ни `%`, ни `_`, ни одинарных кавычек —
 * экранировать нечего (двойные кавычки вокруг "domain" для LIKE не особые).
 */
const AGENT_OUTDATED_LIKE = `'${AGENT_OUTDATED_MARKER}%'`;

/**
 * Чем кончилась попытка перевести заявку в выпуск (см. tryIssue):
 *   queued  — перевели, задание агенту стоит;
 *   busy    — у продукта идёт другое задание: перехода нет вовсе;
 *   taken   — домен в тот же миг занял другой продукт: заявка в failed;
 *   refused — продукт не в том статусе (погашен, не заведён, в архиве);
 *   none    — заявки с этим кодом в ожидаемом статусе уже нет;
 *   limited — исчерпан предел: окно повторов (из failed) или заданий domain
 *             у продукта за час.
 */
export type IssueOutcome = 'queued' | 'busy' | 'taken' | 'refused' | 'none' | 'limited';

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
  /** Русский текст ошибки — для ассистента и запасной показ. */
  error: string | null;
  /** Её код — по нему кабинет переводит ошибку. Задан ровно тогда, когда задан `error`. */
  errorReason: DomainErrorReason | null;
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
  | 'removing' // домен отвязывается — привязка (любого домена) после окончания
  | 'busy'
  | 'changed' // заявку отвязали или заменили, пока с ней работали (проверка DNS шла до ~7 с)
  | 'throttled' // проверка чаще раза в CHECK_THROTTLE_S (429)
  | 'retries' // предел выпусков: RETRIES_PER_HOUR повторов или DOMAIN_JOBS_PER_HOUR заданий в час (429)
  | 'detach_pending'; // отвязка не завершилась — «Проверить снова» выпустил бы домен заново

/**
 * Каждый отказ сервиса — с телом `{ statusCode, message, reason }`. Nest
 * отдаёт объект из HttpException клиенту как есть (BaseExceptionFilter), а
 * `e.message` берёт из поля `message` — ассистент читает его же.
 */
const refusal = (status: number, reason: DomainRefusalCode, message: string) =>
  new HttpException({ statusCode: status, message, reason }, status);

/** Фоновая проверка ждущих DNS. */
export const DOMAIN_TICK_MS = 120_000;
/**
 * Сверка сирот — своим таймером, а не в обороте проверки: проверка DNS одной
 * заявки длится до ~7 с, оборот из PENDING_BATCH — минуты, и строка в issuing
 * без задания всё это время держала бы домен и отказывала бы в отвязке.
 */
export const RECONCILE_TICK_MS = 60_000;
/** Сколько суток после заявки фоновая проверка ещё смотрит DNS. Кнопка работает всегда. */
export const PENDING_DAYS = 7;
/** Сколько ждущих заявок берёт один оборот — сначала давно не проверенные. */
export const PENDING_BATCH = 50;
/** Сколько из них проверяются одновременно: 50 подряд по ~7 с — это минуты. */
export const PENDING_PARALLEL = 5;
/**
 * Проверок DNS одновременно на процесс — всех сразу: привязка, кнопка,
 * фоновый оборот (сервис — одиночка Nest). Лишние ждут своей очереди, а не
 * падают: без предела сотня кнопок разом — это сотня проверок по пять
 * запросов к 1.1.1.1/8.8.8.8 с прод-сервера.
 */
export const DNS_PARALLEL = 8;
/** «Проверить сейчас» и «Проверить снова» — не чаще. Это только DNS, Let's Encrypt не трогается. */
export const CHECK_THROTTLE_S = 30;
/** Повторных выпусков после отказа в час. Предел Let's Encrypt — 5 неудач в час на имя. */
export const RETRIES_PER_HOUR = 3;
/**
 * Заданий domain у продукта за час, после которых выпуск ждёт. Предел
 * бережёт частоту заказов по учётной записи Let's Encrypt машины — она одна
 * на все продукты машины, и её пределы делят все, — и не даёт одному
 * продукту гонять выпуски циклом «привязал → выпустил → отвязал →
 * привязал». Считаются и задания отвязки: цикл из них и состоит.
 *
 * От недельного предела дублей сертификата (5 на один набор имён) он НЕ
 * защищает: 6 заданий в час — это до 3 выпусков в час, и неделя выбирается
 * за ~2 часа. Но дубли бьют только по именам самого пользователя, чужие
 * продукты они не задевают.
 *
 * Считается по product_provision_jobs без своего индекса: таблица заданий
 * маленькая. Вырастет — понадобится индекс (product_id, created_at).
 */
export const DOMAIN_JOBS_PER_HOUR = 6;
/**
 * Заведомо живое имя для контрольного запроса резолвера (probeResolver) —
 * наш собственный домен.
 */
export const RESOLVER_PROBE_NAME = 'linkeon.io';

/**
 * Окно повторов открыто: прошлое окно старше часа (тогда оно начнётся
 * заново) или в нём меньше RETRIES_PER_HOUR выпусков. Один текст на выпуск
 * (tryIssue) и на кнопку (check), и оба — по часам базы: иначе кнопка и
 * оператор считали бы окно по разным часам. `limit` — плейсхолдер параметра
 * с RETRIES_PER_HOUR.
 */
const retryWindowOpen = (limit: string) => `(attempts_since < now() - interval '1 hour' OR attempts < ${limit})`;

/**
 * У продукта $1 за последний час меньше `limit` заданий domain. `limit` —
 * плейсхолдер параметра с DOMAIN_JOBS_PER_HOUR.
 *
 * Задания, на которые устаревший агент ответил «неизвестный вид задания»
 * (AGENT_OUTDATED_MARKER), не в счёт: Let's Encrypt они не трогали, а виноват
 * в них наш выкат, не пользователь. Узнаются по тексту отказа в самом
 * задании — отдельной колонки у product_provision_jobs нет, а 008 таблицу
 * заданий не меняет (только CREATE … IF NOT EXISTS, см. её шапку).
 */
const domainJobsLeft = (limit: string) => `((SELECT count(*) FROM product_provision_jobs j
                  WHERE j.product_id = $1 AND j.kind = 'domain'
                    AND j.created_at > now() - interval '1 hour'
                    AND NOT (j.status = 'failed' AND COALESCE(j.error, '') LIKE ${AGENT_OUTDATED_LIKE})) < ${limit})`;

/**
 * Отказ после НЕЗАВЕРШЁННОЙ отвязки: «Проверить снова» здесь выпустил бы
 * домен заново, а человек его отвязывал. Путь один — «Отвязать» ещё раз.
 */
const DETACH_PENDING: DomainErrorReason[] = ['orphan_removing', 'remove_failed'];
const DETACH_PENDING_SQL = `(${DETACH_PENDING.map((r) => `'${r}'`).join(',')})`;

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
const BLOCKED_ISSUE = 'Продукт остановлен администратором — выпуск сертификата невозможен.';
const NOT_READY_ISSUE = 'Продукт сейчас не работает — выпустить сертификат можно, когда он заработает.';
const NO_DOMAIN = 'У продукта нет своего домена.';
const CHANGED = 'Заявку на домен изменили, пока шла проверка DNS, — обновите страницу и повторите.';
const THROTTLED = 'Проверяли только что — подождите полминуты.';
const RETRIES =
  'Попыток выпуска за последний час уже слишком много — Let’s Encrypt не любит частых повторов. Попробуйте через час.';
const DETACH_PENDING_TEXT = 'Отвязка не завершилась — нажмите «Отвязать» ещё раз.';
const BUSY_ISSUE = 'У продукта сейчас идёт другое задание — повторите через минуту.';
const BUSY = 'У продукта сейчас идёт другое задание — отвяжите через минуту.';
const ISSUING = 'Идёт выпуск сертификата — отвязать можно, когда он закончится (обычно меньше минуты).';
const REMOVING = 'Домен отвязывается — дождитесь окончания, обычно меньше минуты.';
export const ORPHAN_ISSUING =
  'Выпуск прерван: задание снято (продукт остановлен или машина не ответила вовремя). Нажмите «Проверить снова».';
export const ORPHAN_REMOVING =
  'Отвязка прервана: задание снято (продукт остановлен или машина не ответила вовремя). Отвяжите домен ещё раз.';

/**
 * Оператор с постановкой задания откатился ЦЕЛИКОМ, потому что у продукта в
 * тот же миг встало другое задание. Два пути:
 *   - 23505 по единственному активному заданию (product_provision_jobs_one_active):
 *     встречная вставка (сон, пробуждение) прошла мимо NOT EXISTS;
 *   - 40P01, взаимоблокировка с гашением: проверка внешнего ключа нашего
 *     задания берёт KEY SHARE на строку продукта уже ПОСЛЕ записи в
 *     one_active, а гашение и снятие блокировки берут эту строку FOR UPDATE
 *     первым делом и затем вставляют своё задание — каждый ждёт другого.
 * Для вызывающего это «занято», а не сбой: перехода не было вовсе.
 */
const lostToRivalJob = (e: any) =>
  (e?.code === '23505' && e.constraint === 'product_provision_jobs_one_active') || e?.code === '40P01';

/** Счётный семафор: не больше `free` разом, остальные ждут очереди — по порядку прихода. */
class Semaphore {
  private queue: (() => void)[] = [];

  constructor(private free: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.queue.push(resolve));
    try {
      return await fn();
    } finally {
      // Место — прямо следующему в очереди, мимо счётчика: иначе его успел
      // бы перехватить только что пришедший.
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}

interface OwnedProduct {
  id: string;
  slug: string;
  kind: string;
  status: string;
  /** Адрес продукта на платформе (products.domain) — цель CNAME. */
  domain: string | null;
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
  error_reason: DomainErrorReason | null;
  check_result: { records: RecordCheck[] } | null;
  checked_at: string | null;
  attempts: number;
  attempts_since: string;
}

/** Строка заявки с приговором кнопке — по часам базы (см. flagged). */
interface FlaggedRow extends DomainRow {
  throttled: boolean;
  spent: boolean;
}

/** Строка, забронированная кнопкой: `started` — момент брони, он же старт проверки. */
interface HeldRow extends DomainRow {
  started: string;
}

/** Итог одной проверки DNS заявки (runCheck). */
interface CheckRun {
  /** Строка заявки после проверки; null — заявку за это время убрали или заменили. */
  row: DomainRow | null;
  /** Исход выпуска; null — выпуск не просился (DNS не готов, в строке проверка свежее, заявку сменили). */
  issue: IssueOutcome | null;
  /**
   * Коды сбоя, если сбой на КАЖДОЙ записи, иначе null. Чей это сбой — зоны
   * пользователя или нашего резолвера — отсюда не видно: различает
   * контрольный запрос оборота (checkPending).
   */
  allFailed: string | null;
}

type Tick = 'pending' | 'orphans';

@Injectable()
export class DomainsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DomainsService.name);
  /** Поле, а не аргумент конструктора: Nest внедряет только провайдеры, а тесты подменяют резолвер. */
  private resolver: DnsResolver = publicResolver();
  /** Предел одновременных проверок DNS на процесс (DNS_PARALLEL). */
  private readonly dnsGate = new Semaphore(DNS_PARALLEL);
  private timers: NodeJS.Timeout[] = [];
  /** У каждого оборота свой флаг: медленная проверка DNS не должна придерживать сверку сирот. */
  private ticking: Record<Tick, boolean> = { pending: false, orphans: false };
  /** Модуль останавливают: новые обороты не начинаются, идущий не берёт следующих заявок. */
  private stopped = false;

  constructor(private readonly pg: PgService) {}

  onModuleInit() {
    this.stopped = false;
    // unref, иначе таймер держит процесс и jest не завершается.
    const every = (ms: number, tick: Tick) => {
      const t = setInterval(() => void this.safeTick(tick), ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(DOMAIN_TICK_MS, 'pending');
    every(RECONCILE_TICK_MS, 'orphans');
  }

  onModuleDestroy() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * Владелец в WHERE, а не проверкой после выборки: «нет такого» и «есть, но
   * не твой» — одна и та же 404, иначе утекает существование чужих продуктов.
   * Адрес машины — из реестра: продукт второй машины получает её IP и её зону.
   */
  private async owned(userId: string, productId: string): Promise<OwnedProduct> {
    const r = await this.pg.query(
      `SELECT p.id, p.slug, p.kind, p.status, p.domain, host(h.public_ip) AS host_ip, h.domain_suffix
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
    // Адрес продукта — products.domain: источник правды адреса платформы (из
    // него кабинет рисует ссылку, по нему заведение проверяет /health).
    // Склейка слага с зоной машины — только если адреса почему-то нет.
    const target = p.domain || `${p.slug}.${p.domain_suffix}`;
    const out: DomainRecordToSet[] = [{ type: 'TXT', name: relativeName(txtFqdn, zone), fqdn: txtFqdn, value: row.token }];
    for (const fqdn of row.names) {
      // У корня CNAME запрещён стандартом — только A. Остальные имена — CNAME
      // на адрес продукта: переживёт смену IP машины без правки у регистратора.
      out.push(
        fqdn === zone
          ? { type: 'A', name: '@', fqdn, value: p.host_ip }
          : { type: 'CNAME', name: relativeName(fqdn, zone), fqdn, value: target },
      );
    }
    return out;
  }

  private view(row: DomainRow, p: OwnedProduct): DomainView {
    return {
      domain: row.domain,
      domainUnicode: readableDomain(row.domain),
      names: row.names,
      status: row.status,
      error: row.error,
      errorReason: row.error_reason ?? null,
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
    if (existing) return this.answerExisting(existing, n.domain, p);

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

    const created: DomainRow | undefined = ins.rows[0];
    if (!created) {
      // Строку продукта в ту же секунду завела параллельная привязка. Проверку
      // DNS гоняет она — тот, кто строку завёл; здесь только ответ по этой
      // строке, как если бы она была до нас.
      const other = await this.rowOf(productId);
      if (!other) {
        // ...а параллельная отвязка — уже и снять её.
        throw refusal(HttpStatus.CONFLICT, 'changed', 'Заявку на домен в ту же секунду сняли — обновите страницу и повторите.');
      }
      return this.answerExisting(other, n.domain, p);
    }

    // Исход выпуска привязке не важен: не вышло сейчас — выпустит фоновый
    // оборот, а состояние покажет строка.
    const run = await this.runCheck(created, p);
    // Показать здесь строку продукта значило бы выдать чужую заявку за эту:
    // ответ на привязку a.ru с доменом b.ru.
    if (!run.row) throw refusal(HttpStatus.CONFLICT, 'changed', CHANGED);
    return this.view(run.row, p);
  }

  /**
   * Привязка при уже существующей строке продукта. Пока идёт отвязка —
   * отказ для ЛЮБОГО домена: «сначала отвяжите» было бы неправдой (уже
   * отвязывается), а 200 со строкой в removing — обещанием домена, который
   * вот-вот снимут. Тот же домен — ответ по строке без новой проверки,
   * другой — у продукта уже есть свой.
   */
  private answerExisting(existing: DomainRow, domain: string, p: OwnedProduct): DomainView {
    if (existing.status === 'removing') throw refusal(HttpStatus.CONFLICT, 'removing', REMOVING);
    if (existing.domain !== domain) {
      throw refusal(
        HttpStatus.CONFLICT,
        'has_domain',
        `У продукта уже есть свой домен ${readableDomain(existing.domain)} — сначала отвяжите его.`,
      );
    }
    return this.view(existing, p);
  }

  async detach(userId: string, productId: string): Promise<{ removed: 'now' | 'queued' }> {
    await this.owned(userId, productId);
    let row = await this.rowOf(productId);
    if (!row) throw refusal(HttpStatus.NOT_FOUND, 'no_domain', NO_DOMAIN);

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
    if (row.status === 'issuing') throw refusal(HttpStatus.CONFLICT, 'issuing', ISSUING);
    if (row.status === 'removing') return { removed: 'queued' };

    try {
      const r = await this.pg.query(
        `WITH d AS (
            UPDATE product_domains SET status = 'removing', error = NULL, error_reason = NULL
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
      if (e?.code === '23505' && e.constraint === 'product_domains_occupied') {
        // Перевод failed → removing упёрся в индекс занятых: домен уже держит
        // другой продукт, и в removing эту заявку не пустить. Удалить строку
        // голым DELETE тоже нельзя: failed бывает и после отказа выпуска
        // (Let's Encrypt, агент) или снятого задания — у такой заявки на
        // машине могли остаться блоки порта 80, а то и сертификат.
        if (await this.dropOccupiedFailed(productId)) return { removed: 'now' };
      } else if (!lostToRivalJob(e)) {
        throw e;
      }
      // Иначе встречное задание (сон, пробуждение, гашение) — оператор
      // откатился целиком, решает свежее состояние ниже.
    }
    // Своё действие не состоялось — кто-то успел раньше. Ответ — по свежему
    // состоянию, а не «занято» наугад: вторая отвязка той же строки — это не
    // «другое задание», а отвязка, уже поставленная первой.
    const cur = await this.rowOf(productId);
    if (!cur) return { removed: 'now' };
    if (cur.status === 'removing') return { removed: 'queued' };
    if (cur.status === 'issuing') throw refusal(HttpStatus.CONFLICT, 'issuing', ISSUING);
    throw refusal(HttpStatus.CONFLICT, 'busy', BUSY);
  }

  /**
   * Отвязка отказавшей заявки, чей домен уже держит другой продукт (перевод
   * в removing не пускает индекс занятых). Строка удаляется, и ТЕМ ЖЕ
   * оператором ставится задание domain: у продукта больше нет строки в
   * issuing/active, агент получит пустой список имён — уберёт свои имена из
   * конфига и удалит сертификат (его отсутствие он терпит). Так на машине не
   * остаётся хвостов, чем бы ни кончился прежний выпуск — отказом Let's
   * Encrypt, снятым заданием или отказом taken, для которого задание просто
   * безвредно. Двумя операторами строка могла бы уйти без задания.
   *
   * true — строка удалена и задание стоит. false — у продукта идёт другое
   * задание (видимое — NOT EXISTS; встречное — lostToRivalJob, и тогда
   * оператор откатился целиком): строка на месте, ответ решает перечитывание.
   */
  private async dropOccupiedFailed(productId: string): Promise<boolean> {
    try {
      const r = await this.pg.query(
        `WITH del AS (
            DELETE FROM product_domains
             WHERE product_id = $1 AND status = 'failed'
               AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                                WHERE j.product_id = $1 AND j.status IN ('queued','running'))
            RETURNING product_id
         ), q AS (
            INSERT INTO product_provision_jobs (product_id, kind, status)
            SELECT product_id, 'domain', 'queued' FROM del
            RETURNING product_id
         )
         SELECT (SELECT count(*) FROM q)::int AS queued`,
        [productId],
      );
      return r.rows[0].queued === 1;
    } catch (e: any) {
      if (lostToRivalJob(e)) return false;
      throw e;
    }
  }

  /**
   * «Проверить сейчас» (awaiting_dns) и «Проверить снова» (failed). В прочих
   * состояниях проверять нечего — ответ по строке.
   *
   * Пауза между проверками — БРОНЬ одним оператором до DNS (hold), а не
   * чтение checked_at: десять нажатий разом прочли бы одну и ту же старую
   * отметку и пустили бы десять проверок. Бронь берётся при всех условиях
   * кнопки сразу (статус, пауза, незавершённая отвязка, окно повторов) и
   * держит тот же код заявки; не взялась — отказ разбирается по свежей строке.
   * Все сроки — по часам базы, как и в операторе выпуска.
   *
   * Исход выпуска у повтора (failed) отвечается честно: «занято», предел,
   * погашен — иначе 200 со старой ошибкой, а фоновый оборот failed не
   * повторяет. У ждущей заявки (awaiting_dns) 200: не вышло сейчас — оборот
   * повторит; кроме предела — его оборот тоже упрётся в час.
   */
  async check(userId: string, productId: string): Promise<DomainView> {
    const p = await this.owned(userId, productId);
    const row = await this.flagged(productId);
    if (!row) throw refusal(HttpStatus.NOT_FOUND, 'no_domain', NO_DOMAIN);
    if (row.status !== 'awaiting_dns' && row.status !== 'failed') return this.view(row, p);
    // Погашенному выпуск запрещён (см. ISSUABLE) — и DNS незачем трогать.
    if (p.status === 'blocked') throw refusal(HttpStatus.CONFLICT, 'blocked', BLOCKED_ISSUE);
    const early = this.cannotCheck(row);
    if (early) throw early;

    const held = await this.hold(row);
    if (!held) {
      const cur = await this.flagged(productId);
      if (!cur || cur.token !== row.token) throw refusal(HttpStatus.CONFLICT, 'changed', CHANGED);
      // Заявка ушла дальше (выпуск её уже взял) — проверять нечего, ответ по строке.
      if (cur.status !== 'awaiting_dns' && cur.status !== 'failed') return this.view(cur, p);
      throw this.cannotCheck(cur) ?? refusal(HttpStatus.TOO_MANY_REQUESTS, 'throttled', THROTTLED);
    }

    const run = await this.runCheck(held, p, held.started);
    // Заявку отвязали или заменили, пока шла проверка: новая строка в ответе
    // выдала бы себя за проверенную.
    if (!run.row) throw refusal(HttpStatus.CONFLICT, 'changed', CHANGED);
    if (run.issue === 'limited') throw refusal(HttpStatus.TOO_MANY_REQUESTS, 'retries', RETRIES);
    if (held.status === 'failed' && run.issue === 'busy') throw refusal(HttpStatus.CONFLICT, 'busy', BUSY_ISSUE);
    if (held.status === 'failed' && run.issue === 'refused') {
      // Продукт за время проверки перестал годиться для выпуска — по его
      // свежему статусу и отказ.
      const now = await this.owned(userId, productId);
      if (now.status === 'blocked') throw refusal(HttpStatus.CONFLICT, 'blocked', BLOCKED_ISSUE);
      throw refusal(HttpStatus.CONFLICT, 'not_ready', NOT_READY_ISSUE);
    }
    return this.view(run.row, p);
  }

  /** Строка заявки с приговором кнопке: пауза не вышла (throttled), окно повторов исчерпано (spent). */
  private async flagged(productId: string): Promise<FlaggedRow | null> {
    const r = await this.pg.query(
      `SELECT d.*,
              COALESCE(d.checked_at > now() - make_interval(secs => $2), false) AS throttled,
              NOT ${retryWindowOpen('$3')} AS spent
         FROM product_domains d
        WHERE d.product_id = $1`,
      [productId, CHECK_THROTTLE_S, RETRIES_PER_HOUR],
    );
    return r.rows[0] ?? null;
  }

  /** Почему кнопку нажимать рано или незачем; null — можно проверять. */
  private cannotCheck(row: FlaggedRow): HttpException | null {
    if (row.status === 'failed' && DETACH_PENDING.includes(row.error_reason)) {
      return refusal(HttpStatus.CONFLICT, 'detach_pending', DETACH_PENDING_TEXT);
    }
    if (row.status === 'failed' && row.spent) return refusal(HttpStatus.TOO_MANY_REQUESTS, 'retries', RETRIES);
    if (row.throttled) return refusal(HttpStatus.TOO_MANY_REQUESTS, 'throttled', THROTTLED);
    return null;
  }

  /**
   * Бронь кнопки: отметка checked_at ставится ДО проверки DNS, одним
   * оператором и при всех условиях cannotCheck сразу — из десятка нажатий
   * разом её получает ровно одно. Адрес — код заявки: бронь не ложится на
   * заявку, заведённую вместо прочитанной. null — брони нет.
   */
  private async hold(row: DomainRow): Promise<HeldRow | null> {
    const r = await this.pg.query(
      `UPDATE product_domains SET checked_at = clock_timestamp()
        WHERE product_id = $1 AND token = $2 AND status IN ('awaiting_dns','failed')
          AND (checked_at IS NULL OR checked_at <= clock_timestamp() - make_interval(secs => $3))
          AND (status = 'awaiting_dns'
               OR (${retryWindowOpen('$4')} AND COALESCE(error_reason, '') NOT IN ${DETACH_PENDING_SQL}))
       RETURNING *, checked_at::text AS started`,
      [row.product_id, row.token, CHECK_THROTTLE_S, RETRIES_PER_HOUR],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Проверка DNS ЗАЯВКИ и сохранение результата. Ошибку Let's Encrypt
   * (`error`) не трогает.
   *
   * Результат принадлежит заявке — её коду в TXT, — а не продукту. Проверка
   * длится до ~7 с, и длительность держит владелец проверяемого домена: его
   * сервер может отвечать ровно столько, сколько нужно. Если за это время
   * заявку отвязали и завели другую (другой домен или тот же с новым кодом),
   * запись по одному product_id положила бы «всё зелёное» от старой заявки в
   * строку новой, а выпуск стартовал бы для домена, чей TXT в DNS не появлялся
   * ни разу, — обход проверки владения. Поэтому и запись, и выпуск адресуются
   * парой (product_id, token).
   *
   * Две проверки ОДНОЙ заявки тоже расходятся по времени (кнопка и фоновый
   * оборот, два процесса кластера): та, что стартовала раньше, а ответила
   * позже, несёт более старое состояние DNS. Поэтому checked_at — момент
   * СТАРТА проверки по часам базы (у кнопки — момент брони, `heldAt`), и
   * результат пишется, только если в строке не лежит проверка, стартовавшая
   * позже. Иначе остаётся свежий результат, а выпуск по старому не просится.
   *
   * Сама проверка — под общим пределом DNS_PARALLEL на процесс: лишние ждут
   * очереди.
   *
   * Выпуск просится только из статуса, прочитанного вызывающим (awaiting_dns
   * или failed), и оператор выпуска сверяет его сам: фоновый оборот берёт
   * только awaiting_dns и отказавшую заявку не перевыпустит даже в гонке —
   * иначе он обходил бы предел повторов. Исход выпуска — наружу: кнопке он
   * нужен для честного ответа.
   *
   * row: null — заявку за время проверки убрали или заменили: результат
   * никуда не записан, выпуск не просился. Вызывающий обязан это разобрать
   * (attach и check — 409 changed, фоновый оборот — пропустить).
   */
  private async runCheck(row: DomainRow, p: OwnedProduct, heldAt?: string): Promise<CheckRun> {
    const { started, result } = await this.dnsGate.run(async () => {
      // Без брони момент старта берётся уже в очереди: ожидание места
      // проверкой не считается. Текстом, а не Date: node-postgres режет
      // timestamptz до миллисекунд, и две проверки внутри одной миллисекунды
      // сравнялись бы.
      const at: string = heldAt ?? (await this.pg.query(`SELECT clock_timestamp()::text AS t`)).rows[0].t;
      const dns = await checkDns({ domain: row.domain, names: row.names, token: row.token, hostIp: p.host_ip }, this.resolver);
      return { started: at, result: dns };
    });
    const allFailed = result.records.every((c) => c.error)
      ? [...new Set(result.records.map((c) => c.error))].join(',')
      : null;
    const saved = await this.pg.query(
      `UPDATE product_domains SET check_result = $2::jsonb, checked_at = $4::timestamptz
        WHERE product_id = $1 AND token = $3
          AND (checked_at IS NULL OR checked_at <= $4::timestamptz)`,
      [row.product_id, JSON.stringify({ records: result.records }), row.token, started],
    );
    if (saved.rowCount === 0) {
      // Заявки нет или она другая — null. Та же заявка — значит, в ней уже
      // лежит проверка, стартовавшая позже нашей: отвечаем ею, без выпуска.
      const cur = await this.rowOf(row.product_id);
      return { row: cur?.token === row.token ? cur : null, issue: null, allFailed };
    }
    const expected = row.status;
    let issue: IssueOutcome | null = null;
    if (result.ok && (expected === 'awaiting_dns' || expected === 'failed')) {
      issue = await this.tryIssue(row.product_id, row.token, expected);
    }
    const fresh = await this.rowOf(row.product_id);
    return { row: fresh?.token === row.token ? fresh : null, issue, allFailed };
  }

  /**
   * Перевод ЗАЯВКИ в выпуск и постановка задания агенту — ОДИН оператор. Два
   * шага оставили бы домен в issuing без задания навсегда, если между ними у
   * продукта встанет сон или пробуждение: встречная вставка роняет весь
   * оператор, и перевод откатывается вместе с ней (lostToRivalJob — busy).
   *
   * Адрес — заявка, а не продукт: (product_id, token) и статус, который
   * вызывающий прочитал. Между проверкой DNS и выпуском заявку могут отвязать
   * и завести новую — вызов со старым кодом кончается 'none' и новую не
   * трогает: её TXT в DNS мог не появиться ни разу. А ожидаемый статус не
   * даёт фоновому обороту (он спрашивает из awaiting_dns) перевыпустить
   * отказавшую заявку мимо предела повторов.
   *
   * Пределы — в самом операторе, 'limited': окно повторов из failed
   * (retryWindowOpen; обычный путь отбивает его раньше, в check(), здесь
   * страховка на гонку) и DOMAIN_JOBS_PER_HOUR заданий domain у продукта за
   * час — из любого статуса.
   *
   * Исход — см. IssueOutcome. Флаги итогового SELECT смотрят в снимок
   * оператора, а UPDATE, дождавшись чужой блокировки строки, перечитывает её
   * свежей. Заявка, которую в тот же миг перевёл встречный оператор, выглядит
   * в снимке ждущей, хотя UPDATE её уже не взял, — и это 'none', а не
   * 'limited': 'limited' — только когда предел в снимке действительно
   * исчерпан.
   */
  async tryIssue(productId: string, token: string, expected: 'awaiting_dns' | 'failed'): Promise<IssueOutcome> {
    try {
      const r = await this.pg.query(
        `WITH d AS (
            UPDATE product_domains
               SET status = 'issuing', error = NULL, error_reason = NULL,
                   -- Попытка списывается здесь, в начале повтора, при ЛЮБОЙ
                   -- прошлой причине: чей будет отказ, ясно только в отчёте.
                   -- Повтор, ушедший устаревшему агенту, возвращает её при
                   -- приёме отчёта (completeDomainJob, agent_outdated).
                   attempts = CASE WHEN status <> 'failed' THEN attempts
                                   WHEN attempts_since < now() - interval '1 hour' THEN 1
                                   ELSE attempts + 1 END,
                   attempts_since = CASE WHEN status = 'failed' AND attempts_since < now() - interval '1 hour'
                                         THEN now() ELSE attempts_since END
             WHERE product_id = $1 AND token = $2 AND status = $3
               AND ($3::text = 'awaiting_dns' OR ${retryWindowOpen('$4')})
               AND ${domainJobsLeft('$5')}
               AND EXISTS (SELECT 1 FROM products p
                            WHERE p.id = $1 AND p.archived_at IS NULL AND p.status IN ${ISSUABLE_SQL})
               AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                                WHERE j.product_id = $1 AND j.status IN ('queued','running'))
            RETURNING product_id, domain
         ), q AS (
            INSERT INTO product_provision_jobs (product_id, kind, status)
            SELECT product_id, 'domain', 'queued' FROM d
            RETURNING product_id
         )
         SELECT (SELECT count(*) FROM q)::int AS queued,
                (SELECT domain FROM d) AS domain,
                EXISTS (SELECT 1 FROM product_domains
                         WHERE product_id = $1 AND token = $2 AND status = $3) AS waiting,
                EXISTS (SELECT 1 FROM products p
                         WHERE p.id = $1 AND p.archived_at IS NULL AND p.status IN ${ISSUABLE_SQL}) AS issuable,
                EXISTS (SELECT 1 FROM product_provision_jobs j
                         WHERE j.product_id = $1 AND j.status IN ('queued','running')) AS job_active,
                (EXISTS (SELECT 1 FROM product_domains
                          WHERE product_id = $1 AND token = $2 AND status = 'failed' AND $3::text = 'failed'
                            AND NOT ${retryWindowOpen('$4')})
                 OR NOT ${domainJobsLeft('$5')}) AS spent`,
        [productId, token, expected, RETRIES_PER_HOUR, DOMAIN_JOBS_PER_HOUR],
      );
      const { queued, domain, waiting, issuable, job_active, spent } = r.rows[0];
      if (queued === 1) {
        this.logger.log(`свой домен ${domain}: выпуск сертификата поставлен (продукт ${productId})`);
        return 'queued';
      }
      if (!waiting) return 'none';
      if (!issuable) return 'refused';
      if (job_active) return 'busy';
      if (spent) return 'limited';
      return 'none'; // заявку в тот же миг перевёл встречный оператор — см. докблок
    } catch (e: any) {
      if (e?.code === '23505' && e.constraint === 'product_domains_occupied') {
        // Домен в тот же миг ушёл в выпуск у другого продукта — индекс
        // занятых доменов не пустил эту заявку. Адрес тот же, (product_id,
        // token): отказ ложится только на неё, а не на заявку, которую
        // успели завести вместо неё, — тогда это 'none'.
        const t = await this.pg.query(
          `UPDATE product_domains SET status = 'failed', error = $3, error_reason = 'taken'
            WHERE product_id = $1 AND token = $2 AND status IN ('awaiting_dns','failed')
           RETURNING domain`,
          [productId, token, TAKEN],
        );
        if (!t.rows[0]) return 'none';
        this.logger.warn(`свой домен ${t.rows[0].domain}: в тот же миг занят другим продуктом — заявка продукта ${productId} в failed (taken)`);
        return 'taken';
      }
      if (lostToRivalJob(e)) return 'busy';
      throw e;
    }
  }

  /**
   * Фоновый оборот: заявки в awaiting_dns не старше PENDING_DAYS у продуктов,
   * которым можно выпускать (погашенных не берёт), сначала давно не
   * проверенные. Только awaiting_dns: повтор после отказа — кнопкой, с
   * пределом в час. Брони кнопки оборот не делает: у него своя очерёдность.
   *
   * По PENDING_PARALLEL заявок разом: проверка одной — до ~7 с. Сбой одной — в
   * лог, оборот идёт дальше; null от runCheck (заявку за это время сменили) —
   * пропуск. Остановка модуля (stopped) — следующую заявку воркеры не берут.
   *
   * В обычной работе оборот молчит. Сбой у всех заявок оборота — ещё не наш
   * сбой: SERVFAIL значит, что резолвер ответил, а битая — зона
   * пользователя, ETIMEOUT бывает от мёртвого сервера его зоны; одна такая
   * заявка писала бы строку на каждом обороте до семи суток. Поэтому тогда —
   * ОДИН контрольный запрос через тот же резолвер к заведомо живому имени
   * (RESOLVER_PROBE_NAME), и сводная строка — только если не ответил и он:
   * это и есть наш сетевой сбой, с машины недоступны 1.1.1.1 и 8.8.8.8.
   *
   * Возвращает, сколько заявок взято в оборот.
   */
  async checkPending(): Promise<number> {
    if (this.stopped) return 0;
    const r = await this.pg.query(
      `SELECT d.*, p.slug, p.kind, p.status AS product_status, p.domain AS product_address,
              host(h.public_ip) AS host_ip, h.domain_suffix
         FROM product_domains d
         JOIN products p ON p.id = d.product_id
         JOIN product_hosts h ON h.id = p.host_id
        WHERE d.status = 'awaiting_dns'
          AND d.created_at > now() - make_interval(days => $1)
          AND p.archived_at IS NULL AND p.status IN ${ISSUABLE_SQL}
        ORDER BY d.checked_at NULLS FIRST
        LIMIT $2`,
      [PENDING_DAYS, PENDING_BATCH],
    );
    const rows: any[] = r.rows;
    let taken = 0;
    let checked = 0;
    const codes = new Set<string>();
    let failedAll = 0;
    const worker = async () => {
      while (!this.stopped && taken < rows.length) {
        const row = rows[taken++];
        const p: OwnedProduct = {
          id: row.product_id,
          slug: row.slug,
          kind: row.kind,
          status: row.product_status,
          domain: row.product_address,
          host_ip: row.host_ip,
          domain_suffix: row.domain_suffix,
        };
        try {
          const run = await this.runCheck(row, p);
          checked++;
          if (run.allFailed) {
            failedAll++;
            codes.add(run.allFailed);
          }
        } catch (e: any) {
          this.logger.warn(`проверка DNS ${row.domain}: ${e?.message ?? e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PENDING_PARALLEL, rows.length) }, worker));
    if (checked > 0 && failedAll === checked) {
      const probe = await probeResolver(this.resolver, RESOLVER_PROBE_NAME);
      if (probe) {
        this.logger.warn(
          `проверка DNS: сбой у всех ${checked} заявок оборота (${[...codes].join('; ')}), и контрольный запрос ` +
            `${RESOLVER_PROBE_NAME} без ответа (${probe}) — с машины недоступны 1.1.1.1 и 8.8.8.8`,
        );
      }
    }
    return taken;
  }

  /**
   * Сироты: строки в issuing и removing, у продукта которых нет активного
   * задания ИМЕННО вида domain. Законная такая строка его всегда имеет: оба
   * перехода делаются одним оператором вместе с заданием, а единственное
   * активное задание продукта (one_active) другого вида рядом с ним не
   * пустит; закрывает их тоже один оператор (приём отчёта, задача 6).
   * Значит, задание сняли снаружи: гашение и снятие блокировки снимают
   * активное задание ЛЮБОГО вида (block.service.ts, killed_jobs), сборщик
   * зависших — тоже (failStaleProvisioning). По любому виду сирота ждала бы,
   * пока кончится сон, который гашение тут же ставит. Без сверки строка
   * осталась бы в issuing навсегда: отвязать нельзя, индекс держит домен.
   *
   * В failed, а не повторная постановка: повтор крутился бы вечно там, где
   * задание снимают раз за разом (машина молчит, продукт гасят), а failed
   * отдаёт решение человеку и пределу повторов. Текст — для ассистента, код
   * — для кабинета.
   */
  async reconcileOrphans(): Promise<number> {
    const r = await this.pg.query(
      `UPDATE product_domains d
          SET status = 'failed',
              error = CASE d.status WHEN 'removing' THEN $1 ELSE $2 END,
              error_reason = CASE d.status WHEN 'removing' THEN 'orphan_removing' ELSE 'orphan_issuing' END
        WHERE d.status IN ('issuing','removing')
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = d.product_id AND j.kind = 'domain'
                             AND j.status IN ('queued','running'))
       RETURNING d.product_id, d.domain, d.error_reason`,
      [ORPHAN_REMOVING, ORPHAN_ISSUING],
    );
    if (r.rows.length) {
      this.logger.warn(
        `домены без задания переведены в failed: ${r.rows
          .map((x: any) => `${x.domain} (${x.product_id}, ${x.error_reason})`)
          .join(', ')}`,
      );
    }
    return r.rows.length;
  }

  /**
   * Оборот не перекрывается сам с собой: медленный DNS не должен плодить
   * параллельные проходы. Флаг у каждого оборота свой — сверку сирот
   * медленная проверка не придерживает. Сбой — в лог, не в процесс.
   */
  private async safeTick(tick: Tick) {
    if (this.stopped || this.ticking[tick]) return;
    this.ticking[tick] = true;
    try {
      if (tick === 'pending') await this.checkPending();
      else await this.reconcileOrphans();
    } catch (e: any) {
      const what = tick === 'pending' ? 'проверка ждущих DNS' : 'сверка сирот';
      this.logger.error(`оборот своих доменов (${what}) упал: ${e?.message ?? e}`);
    } finally {
      this.ticking[tick] = false;
    }
  }
}
