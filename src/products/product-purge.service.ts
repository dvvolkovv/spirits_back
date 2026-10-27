import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { PURGED_TEXT, SLUG_RE } from './provisioning.service';

/**
 * Раз в час, а не раз в сутки: API перезапускается выкатами несколько раз в
 * день, и суточный таймер не доживал бы до первого срабатывания никогда.
 * Условие стирания — purge_after <= now(), так что продукт стирается в первый
 * час после срока. Первый обход — через час после старта, а не на старте:
 * выкат сервера идёт раньше выката агента машины (deploy.sh, PHASE 2 и 4), и
 * обход на старте отдал бы purge агенту, который его ещё не знает.
 */
export const PURGE_TICK_MS = 60 * 60 * 1000;
/** Тот же потолок, что у сна удалённого (queueSleepForDeleted). */
const PURGE_FAIL_CAP = 3;

/**
 * Корень резервных копий: PRODUCT_REPOS_DIR или ~/product-repos пользователя
 * процесса API — туда их кладёт scripts/product-backup-setup.sh
 * (REPO_ROOT=/home/dvolkov/product-repos, API на проде работает от dvolkov).
 * Абсолютный и не ближе двух уровней к корню ФС — иначе стирать из него нельзя.
 */
export function reposRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PRODUCT_REPOS_DIR;
  const root = raw ? raw : path.join(os.homedir(), 'product-repos');
  if (!path.isAbsolute(root)) throw new Error(`PRODUCT_REPOS_DIR не абсолютный: ${JSON.stringify(raw)}`);
  const resolved = path.resolve(root);
  if (resolved.split('/').filter(Boolean).length < 2) throw new Error(`каталог копий ${resolved} слишком близко к корню ФС`);
  return resolved;
}

/**
 * Путь копии ЭТОГО продукта на ЭТОЙ машине — или null.
 *
 * Стираем только то, на что указывает repo_url продукта, и только если это
 * ровно `<корень>/<слаг>.git`: слаг сверяется SLUG_RE, путь нормализуется, и
 * результат обязан лежать прямо в корне. Копия другой машины (repo_url с
 * чужим путём), чужой формы (https) или с `..` — не наша. Имя хоста в
 * repo_url не сверяется (отступление 11): стирается каталог по этому пути на
 * машине API, а ссылки по дороге сверяет removeBackups по настоящей ФС.
 */
export function backupPathFor(repoUrl: string, slug: string, root: string): string | null {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  const m = /^(?:(?:[^@/:\s]+@)?[^/:\s]+:)?(\/\S+)$/.exec(String(repoUrl ?? ''));
  if (!m) return null;
  const want = path.join(root, `${slug}.git`);
  if (path.dirname(want) !== root) return null;
  return path.resolve(m[1]) === want ? want : null;
}

/** Код ошибки ФС (`EACCES`) — или общее слово; сообщение fs несёт пути внутри копии. */
function fsCode(e: any): string {
  const code = e?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : String(e?.message ?? e).slice(0, 200);
}

/**
 * Стирание удалённых продуктов (очередь 2): после срока возврата стирает на
 * сервере ключи и свободный текст продукта, ставит задание purge агенту
 * машины и стирает резервные копии уже стёртых. Пометку «стёрт» ставит отчёт
 * агента (ProvisioningService.completePurgeJob).
 */
@Injectable()
export class ProductPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductPurgeService.name);
  private timer?: NodeJS.Timeout;
  /**
   * Разовые предупреждения на процесс — тот же приём, что warnedSleepCap в
   * product-lifecycle.service.ts: подсказка живому человеку в логе, на
   * поведение обхода множество не влияет.
   */
  private warned = new Set<string>();

  constructor(private readonly pg: PgService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), PURGE_TICK_MS);
    // unref, иначе таймер держит процесс и jest не завершается (тот же приём,
    // что у таймеров product-lifecycle.service.ts).
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Шаги — каждый под своим safe: отказ одного (обрыв с базой, сбой ФС) не
   * отменяет остальные. Ключи — первыми: их стирание не зависит ни от
   * машины, ни от очереди.
   */
  async tick(): Promise<void> {
    await this.safe('стирание ключей после срока', () => this.wipeExpired());
    await this.safe('обход стирания', () => this.queuePurges());
    await this.safe('стирание резервных копий', () => this.removeBackups());
  }

  private async safe(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      this.logger.error(`${name}: ${e?.message}`);
    }
  }

  /**
   * Ключи и свободный текст удалённого не переживают срок возврата — даже
   * если стирание на машине упрётся в потолок провалов или машина лежит
   * (отступление 16 плана). Вернуть такой продукт уже нельзя (restore требует
   * purge_after > now()), так что ни ключи, ни тексты больше не нужны никому.
   *
   * Стирается тот же набор, что у completePurgeJob на сервере, — без того,
   * что зависит от машины: пометку «стёрт» ставит только отчёт агента, а
   * строка своего домена остаётся, пока vhost с этим именем ещё может жить
   * на машине. Сверх ключей продукта — тексты правок и первая правка в
   * карточках (решение по ревью задачи 10: иначе «стирается насовсем» было бы
   * неправдой — а при потолке провалов тексты жили бы вечно; владельцы
   * вставляют в правки и токены) и коробки ключей карточек (product_actions.
   * secrets_box — тоже ключи). Числа, статусы, sha и время остаются.
   *
   * Отбор — по тому, есть ли что стирать: стёртое не переписывается каждый
   * час заново. purged_at IS NULL — стёртые агентом completePurgeJob уже
   * вычистил, и обход не перебирает их правки до конца времён.
   */
  async wipeExpired(): Promise<number> {
    const r = await this.pg.query(
      `WITH due AS (
          UPDATE products p
             SET secrets_encrypted = NULL, first_prompt = NULL, first_prompt_channel = NULL
           WHERE p.archived_at IS NOT NULL AND p.purged_at IS NULL
             AND p.purge_after IS NOT NULL AND p.purge_after <= now()
             AND (p.secrets_encrypted IS NOT NULL OR p.first_prompt IS NOT NULL OR p.first_prompt_channel IS NOT NULL
                  OR EXISTS (SELECT 1 FROM product_turns t
                              WHERE t.product_id = p.id
                                AND (t.prompt <> $1::text OR t.result <> $1::text OR t.error <> $1::text))
                  OR EXISTS (SELECT 1 FROM product_actions a
                              WHERE a.product_id = p.id AND (a.secrets_box IS NOT NULL OR a.payload ? 'prompt')))
          RETURNING p.id
       ), turns AS (
          UPDATE product_turns t
             SET prompt = $1::text,
                 result = CASE WHEN t.result IS NULL THEN NULL ELSE $1::text END,
                 error = CASE WHEN t.error IS NULL THEN NULL ELSE $1::text END
            FROM due
           WHERE t.product_id = due.id
             AND (t.prompt <> $1::text OR t.result <> $1::text OR t.error <> $1::text)
          RETURNING t.id
       ), actions AS (
          UPDATE product_actions a
             SET secrets_box = NULL, payload = a.payload - 'prompt'
            FROM due
           WHERE a.product_id = due.id AND (a.secrets_box IS NOT NULL OR a.payload ? 'prompt')
          RETURNING a.id
       )
       SELECT (SELECT count(*) FROM due)::int AS products,
              (SELECT count(*) FROM turns)::int AS turns,
              (SELECT count(*) FROM actions)::int AS actions`,
      [PURGED_TEXT],
    );
    const row = r.rows[0] ?? { products: 0, turns: 0, actions: 0 };
    if (row.products > 0) {
      this.logger.log(`срок возврата вышел: у ${row.products} удалённых стёрты ключи и тексты (правок ${row.turns}, карточек ${row.actions})`);
    }
    return Number(row.products);
  }

  /**
   * Потолок — 3 провала подряд ПОСЛЕ этой архивации, как у сна удалённого
   * (j.created_at >= p.archived_at: провалы прошлого цикла архив/возврат не
   * считаются). Считаются только задания, которые агент забрал (started_at
   * есть): снятые до выдачи — возвратом, сборщиком при лежащем агенте — не
   * провал стирания (отступление 16).
   */
  async queuePurges(): Promise<number> {
    const capped = await this.pg.query(
      `SELECT p.id, p.slug FROM products p
        WHERE p.archived_at IS NOT NULL AND p.purged_at IS NULL AND p.status = 'archived'
          AND p.purge_after IS NOT NULL AND p.purge_after <= now()
          AND (SELECT count(*) FROM product_provision_jobs j
                WHERE j.product_id = p.id AND j.kind = 'purge' AND j.status = 'failed'
                  AND j.started_at IS NOT NULL AND j.created_at >= p.archived_at) >= $1`,
      [PURGE_FAIL_CAP],
    );
    for (const row of capped.rows) {
      // error, а не warn: без стирания на машине остаются каталог продукта,
      // контейнер и vhost удалённого — повод для ручного разбора. Ключи и
      // тексты на сервере к этому моменту уже стёрты (wipeExpired).
      this.errorOnce(
        `cap:${row.id}`,
        `стирание продукта ${row.id} (${row.slug}) не ставится: ${PURGE_FAIL_CAP} провала подряд — нужен ручной разбор, на машине остались каталог и контейнер`,
      );
    }
    // FOR UPDATE OF p — тот же замок, что у сна удалённых: возврат (restore)
    // держит строку продукта до COMMIT, и стирание, прочитавшее снимок до
    // возврата, иначе встало бы вернувшемуся продукту.
    const r = await this.pg.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status)
       SELECT p.id, 'purge', 'queued' FROM products p
        WHERE p.archived_at IS NOT NULL AND p.purged_at IS NULL AND p.status = 'archived'
          AND p.purge_after IS NOT NULL AND p.purge_after <= now()
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.status IN ('queued','running'))
          AND (SELECT count(*) FROM product_provision_jobs j
                WHERE j.product_id = p.id AND j.kind = 'purge' AND j.status = 'failed'
                  AND j.started_at IS NOT NULL AND j.created_at >= p.archived_at) < $1
          FOR UPDATE OF p
       ON CONFLICT DO NOTHING
       RETURNING product_id`,
      [PURGE_FAIL_CAP],
    );
    return r.rows.length;
  }

  /**
   * Резервные копии стёртых — по строгому пути (backupPathFor) и по
   * настоящей ФС, тем же приёмом, что у агента машины (product-runner,
   * purge.ts, checkedOnDisk):
   *   - корень копий — realpath знак в знак: ссылка по дороге — отказ, а не
   *     «стирать нечего»; корня нет вовсе — тоже отказ, repo_url не трогается
   *     («не знаю, что там» не равно «там пусто»);
   *   - сама копия — lstat, без перехода по ссылке: нет — repo_url обнуляется
   *     (стирать нечего); ссылка или не каталог — не трогаем; каталог — ещё и
   *     realpath знак в знак.
   * Ссылки ВНУТРИ копии fs.rm удаляет как ссылки и по ним не ходит.
   *
   * Без LIMIT: неподходящие копии (чужая машина, чужая форма) остаются с
   * repo_url навсегда, и окно «первые N по purged_at» ими со временем
   * забилось бы — свои копии за ними не стирались бы никогда. Строк здесь
   * единицы: копию заводят руками скриптом, а удачная стирка снимает repo_url.
   */
  async removeBackups(): Promise<number> {
    const r = await this.pg.query(
      `SELECT id, slug, repo_url FROM products
        WHERE purged_at IS NOT NULL AND repo_url IS NOT NULL
        ORDER BY purged_at`,
    );
    if (r.rows.length === 0) return 0;
    const root = reposRoot();
    let realRoot: string;
    try {
      realRoot = await fs.promises.realpath(root);
    } catch (e: any) {
      this.errorOnce(`root:${root}`, `каталог резервных копий ${root} не прочитан (${fsCode(e)}) — копии стёртых продуктов не стираются, repo_url не тронут`);
      return 0;
    }
    if (realRoot !== root) {
      this.errorOnce(`root:${root}`, `каталог резервных копий ${root} на деле ${realRoot} — по дороге ссылка, копии не стираются (задать PRODUCT_REPOS_DIR настоящим путём)`);
      return 0;
    }

    let removed = 0;
    for (const p of r.rows) {
      const where = backupPathFor(p.repo_url, p.slug, root);
      if (!where) {
        this.warnOnce(`foreign:${p.id}`, `резервная копия стёртого продукта ${p.slug} не на этой машине или не по форме (${p.repo_url}) — стереть руками`);
        continue;
      }
      try {
        let st: fs.Stats | null = null;
        try {
          st = await fs.promises.lstat(where);
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
        }
        // lstat, а не stat: символическую ссылку не разыменовываем — она
        // могла бы увести удаление куда угодно.
        if (st && (st.isSymbolicLink() || !st.isDirectory())) {
          this.warnOnce(`odd:${p.id}`, `на месте копии ${where} не каталог — не трогаю, стереть руками`);
          continue;
        }
        if (st) {
          const real = await fs.promises.realpath(where);
          if (real !== where) {
            this.warnOnce(`odd:${p.id}`, `копия ${where} на деле ${real} — не трогаю, стереть руками`);
            continue;
          }
          await fs.promises.rm(where, { recursive: true, force: true });
        }
        // repo_url = $2 — обнуляем ровно то, по чему стирали: переписанный
        // за это время repo_url указывает уже на другую копию.
        await this.pg.query(
          `UPDATE products SET repo_url = NULL WHERE id = $1 AND purged_at IS NOT NULL AND repo_url = $2`,
          [p.id, p.repo_url],
        );
        removed += 1;
      } catch (e: any) {
        this.logger.error(`резервная копия ${p.slug} не стёрта: ${fsCode(e)}`);
      }
    }
    return removed;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }

  private errorOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.error(message);
  }
}
