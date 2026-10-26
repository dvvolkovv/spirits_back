import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ProvisioningService } from './provisioning.service';
import { LimitsService } from './limits.service';
import { TurnsService, TURN_SILENCE_SQL } from './turns.service';
import { SLEEP_REASON_NO_TOKENS } from './rent.service';
import { ActionChannel, ConfirmedVia, DELETE_GRACE_DAYS, ProductActionsService } from './product-actions.service';
import { BotTokenCheck, checkBotToken } from './bot-token-check';
import { randomSuffix, siteSlugCandidates, slugWithSuffix } from './product-slug';

// Срок возврата живёт в журнале (product-actions.service.ts) — одно число на
// оба места; отсюда реэкспорт для инструмента, Telegram и спек.
export { DELETE_GRACE_DAYS };
const NAME_MAX = 80;

export type LifecycleFail = { ok: false; reason: string; message: string };

function cleanName(raw: unknown): string | null {
  const n = String(raw ?? '').trim();
  return n && n.length <= NAME_MAX ? n : null;
}

/**
 * Отказ заведения и прочих сервисов — человеческим текстом и кодом причины.
 *
 * Текст из тела берётся ТОЛЬКО у HttpException — у исключения любой другой
 * природы (обрыв соединения с базой, таймаут пула, необработанный throw
 * внутри зависимости) `e.message` — это текст драйвера pg или Node на
 * английском, с именами колонок и constraint'ов, который ассистент прочитал
 * бы пользователю как собственный отказ продукта. Наружу в этом случае —
 * фиксированная фраза, а сырая ошибка — логгеру (если передан), а не в
 * пустоту: без него диагностировать такой отказ было бы нечем.
 */
function failOf(e: any, fallback: string, logger?: Logger): LifecycleFail {
  if (!(e instanceof HttpException)) {
    logger?.warn(`${fallback}: ${e?.stack ?? e?.message ?? e}`);
    return { ok: false, reason: 'failed', message: 'Не получилось — попробуйте ещё раз позже' };
  }
  const status = e.getStatus();
  const body: any = e.getResponse();
  const raw = typeof body === 'object' && body ? body.message : body;
  const message = String((Array.isArray(raw) ? raw.join('; ') : raw) ?? e?.message ?? fallback);
  const reason = status === 422 ? 'limit' : status === 409 ? 'conflict' : status === 400 ? 'bad_input' : 'failed';
  return { ok: false, reason, message };
}

/**
 * Жизненный цикл продукта по просьбе ассистента: создать, удалить с
 * возвратом, вернуть, откатить правку. Деньги и необратимое — только через
 * ожидающее действие, которое подтверждает человек (product-actions.service).
 *
 * Удаление и возврат ездят на существующих заданиях агента `sleep`/`wake`:
 * агент машины в этой очереди не меняется.
 */
@Injectable()
export class ProductLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductLifecycleService.name);
  /** Поля, а не прямые вызовы: тесты подменяют Telegram и случайный хвост. */
  private checkBot: (token: string) => Promise<BotTokenCheck> = (t) => checkBotToken(t);
  private suffix: () => string = randomSuffix;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly pg: PgService,
    private readonly provisioning: ProvisioningService,
    private readonly limits: LimitsService,
    private readonly turns: TurnsService,
    private readonly actions: ProductActionsService,
  ) {}

  onModuleInit() {
    const firstPrompt = setInterval(() => void this.safe('первая правка', () => this.firstPromptTick()), 30_000);
    // unref, иначе таймер держит процесс и jest не завершается (тот же приём —
    // rent.service.ts, provisioning.service.ts).
    firstPrompt.unref?.();
    this.timers.push(firstPrompt);

    const sleepDeleted = setInterval(() => void this.safe('сон удалённых', () => this.sleepDeletedTick()), 60_000);
    sleepDeleted.unref?.();
    this.timers.push(sleepDeleted);

    // Отдельный оборот, не довесок к соседнему: подметает working-карточки,
    // чей процесс умер между claim и finish/release, не затрагивая pending —
    // смысл другой, и смешивать его с сном удалённых незачем.
    const stuckActions = setInterval(() => void this.safe('зависшие действия', () => this.actions.sweepStuck()), 60_000);
    stuckActions.unref?.();
    this.timers.push(stuckActions);
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }

  private async safe(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      this.logger.error(`${name}: ${e?.message}`);
    }
  }

  /** Признак администратора — та же колонка, что читает JwtGuard. */
  async isAdmin(userId: string): Promise<boolean> {
    const r = await this.pg.query(`SELECT isadmin FROM ai_profiles_consolidated WHERE user_id = $1`, [userId]);
    return r.rows[0]?.isadmin === true;
  }

  private async setFirstPrompt(productId: string, prompt: unknown, channel: ActionChannel): Promise<void> {
    const p = String(prompt ?? '').trim();
    if (!p) return;
    await this.pg.query(
      `UPDATE products SET first_prompt = $2, first_prompt_channel = $3 WHERE id = $1`,
      [productId, p, channel === 'telegram' ? 'telegram' : 'web'],
    );
  }

  async createSite(i: { userId: string; name: unknown; prompt?: unknown; channel: ActionChannel }):
    Promise<{ ok: true; productId: string; slug: string; domain: string | null } | LifecycleFail> {
    const name = cleanName(i.name);
    if (!name) return { ok: false, reason: 'bad_name', message: `Имя продукта — от 1 до ${NAME_MAX} знаков` };
    const isAdmin = await this.isAdmin(i.userId);
    let lastError: any = null;
    for (const slug of siteSlugCandidates(name, this.suffix)) {
      try {
        const { productId } = await this.provisioning.create({ userId: i.userId, name, slug, kind: 'site', secrets: {}, isAdmin });
        await this.setFirstPrompt(productId, i.prompt, i.channel);
        const d = await this.pg.query(`SELECT domain FROM products WHERE id = $1`, [productId]);
        await this.actions.record({ userId: i.userId, productId, kind: 'create_site', channel: i.channel, status: 'done', payload: { name, slug } });
        return { ok: true, productId, slug, domain: d.rows[0]?.domain ?? null };
      } catch (e: any) {
        lastError = e;
        if (e instanceof HttpException && e.getStatus() === 409) continue; // слаг занят — следующий кандидат
        break;
      }
    }
    const f = failOf(lastError, 'Сайт не создан', this.logger);
    await this.actions.record({ userId: i.userId, productId: null, kind: 'create_site', channel: i.channel, status: 'failed', payload: { name }, result: { reason: f.reason, error: f.message } });
    return f;
  }

  async openCreateBot(i: { userId: string; name: unknown; prompt?: unknown; channel: ActionChannel; turn: string | null }):
    Promise<{ ok: true; actionId: string; expiresAt: string } | LifecycleFail> {
    const name = cleanName(i.name);
    if (!name) return { ok: false, reason: 'bad_name', message: `Имя бота — от 1 до ${NAME_MAX} знаков` };
    const prompt = String(i.prompt ?? '').trim();
    const { id, expiresAt } = await this.actions.open({
      userId: i.userId, productId: null, kind: 'create_bot', channel: i.channel, turn: i.turn,
      payload: { name, ...(prompt ? { prompt } : {}) },
    });
    return { ok: true, actionId: id, expiresAt };
  }

  /**
   * Отправка карточки бота. То, что человек может поправить в той же карточке
   * (токен, занятый бот, имя ключа), возвращает её в ожидание с ошибкой.
   */
  async completeCreateBot(i: { userId: string; actionId: string; set: unknown; via: ConfirmedVia }):
    Promise<{ ok: true; productId: string } | LifecycleFail> {
    const row = await this.actions.claim(i.userId, i.actionId, i.via);
    if (!row || row.kind !== 'create_bot') {
      if (row) await this.actions.release(row.id, row.result ?? {});
      return { ok: false, reason: 'not_pending', message: 'Карточка уже закрыта или срок вышел' };
    }
    const secrets: Record<string, string> = {};
    if (i.set && typeof i.set === 'object') {
      for (const [k, v] of Object.entries(i.set as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim() !== '') secrets[k] = k === 'BOT_TOKEN' ? v.trim() : v;
      }
    }
    const check = await this.checkBot(secrets.BOT_TOKEN ?? '');
    // `check.ok === false`, а не `!check.ok`: с выключенным strictNullChecks
    // (tsconfig этого репо) негативная форма не сужает дискриминированное
    // объединение до ветки с `reason` — компилятор держит обе ветки, и
    // `check.reason` ниже не собирается. Равенство литералу сужает верно.
    if (check.ok === false) {
      const message = check.reason === 'unreachable'
        ? 'Не удалось проверить токен в Telegram — попробуйте ещё раз через минуту'
        : 'Telegram не принял токен бота — скопируйте его целиком из @BotFather';
      await this.actions.release(row.id, { error: message, field: 'BOT_TOKEN' });
      return { ok: false, reason: 'bad_token', message };
    }
    const name = String(row.payload?.name ?? '').trim();
    try {
      // Проверка занятости — ТЕПЕРЬ внутри protected-региона: раньше обрыв
      // с базой прямо на этом SELECT проваливался наружу необработанным, и
      // карточка оставалась в working навсегда — ни claim (ждёт pending),
      // ни cancel (тоже) её оттуда не вытаскивают. Единый catch ниже чинит
      // это для любой неожиданной ошибки между claim и finish/release.
      const busy = await this.pg.query(`SELECT 1 FROM products WHERE tg_bot_id = $1 AND archived_at IS NULL LIMIT 1`, [check.id]);
      if (busy.rows.length) {
        const message = 'Этот бот уже работает в другом продукте — создайте в @BotFather нового бота';
        await this.actions.release(row.id, { error: message, field: 'BOT_TOKEN' });
        return { ok: false, reason: 'bot_in_use', message };
      }
      // Второй, окончательный барьер против одного бота в двух продуктах —
      // tgBotId уходит в тот же INSERT, что заводит продукт (а не отдельным
      // UPDATE после): ранняя проверка выше читает только уже живые
      // продукты и не ловит вторую карточку, чей getMe завершился раньше,
      // чем первая успела записать строку. Гонку между ними закрывает
      // партиционный UNIQUE products_tg_bot_live (009_product_actions.sql),
      // а не порядок операторов здесь.
      const { productId } = await this.provisioning.create({
        userId: i.userId, name, slug: slugWithSuffix(name, this.suffix(), 'bot'), kind: 'bot', secrets,
        isAdmin: await this.isAdmin(i.userId), tgBotId: check.id,
      });
      try {
        // Бот уже создан — отказ первой правки не должен откатывать карточку
        // в failed: это сказало бы человеку «бот не создан», когда он уже
        // есть и работает. Лог без секретов (prompt не секрет, но и не
        // причина тащить его в сообщение сверх необходимого) — и всё равно
        // закрываем карточку как done.
        await this.setFirstPrompt(productId, row.payload?.prompt, row.channel);
      } catch (e: any) {
        this.logger.warn(`первая правка бота ${productId} не поставлена: ${e?.message}`);
      }
      await this.actions.finish(row.id, 'done', { productId, botUsername: check.username }, productId);
      return { ok: true, productId };
    } catch (e: any) {
      if (!(e instanceof HttpException)) {
        // Непонятная ошибка (обрыв с базой, таймаут пула) между claim и
        // finish/release — без release карточка умерла бы в working
        // навсегда: claim и cancel требуют status='pending', а working в
        // него без этой строки не возвращается ничем. Текст — общий, сырая
        // ошибка (с именами колонок, текстом драйвера) — в лог, не человеку.
        this.logger.warn(`createBot ${row.id} упал между claim и finish: ${e?.stack ?? e?.message ?? e}`);
        const message = 'Не получилось — попробуйте ещё раз позже';
        await this.actions.release(row.id, { error: message });
        return { ok: false, reason: 'failed', message };
      }
      const f = failOf(e, 'Бот не создан', this.logger);
      if (f.reason === 'conflict' && f.message === 'бот уже работает в другом продукте') {
        // Тот же пользовательский текст, что у ранней SELECT-проверки выше —
        // карточке незачем объяснять, на каком именно шаге поймана гонка.
        const message = 'Этот бот уже работает в другом продукте — создайте в @BotFather нового бота';
        await this.actions.release(row.id, { error: message, field: 'BOT_TOKEN' });
        return { ok: false, reason: 'bot_in_use', message };
      }
      if (f.reason === 'bad_input' || f.reason === 'conflict') await this.actions.release(row.id, { error: f.message });
      else await this.actions.finish(row.id, 'failed', { error: f.message, reason: f.reason });
      return f;
    }
  }

  async openDelete(i: { userId: string; productId: string; channel: ActionChannel; turn: string | null }):
    Promise<{ ok: true; actionId: string; expiresAt: string } | LifecycleFail> {
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, status FROM products WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [i.productId, i.userId],
    );
    const p = r.rows[0];
    if (!p) return { ok: false, reason: 'not_found', message: 'Такого продукта нет' };
    if (p.status === 'provisioning') {
      return { ok: false, reason: 'provisioning', message: 'Продукт ещё заводится — удалить его можно через минуту' };
    }
    const { id, expiresAt } = await this.actions.open({
      userId: i.userId, productId: p.id, kind: 'delete', channel: i.channel, turn: i.turn,
      payload: { name: p.name, slug: p.slug, productKind: p.kind },
    });
    return { ok: true, actionId: id, expiresAt };
  }

  async completeDelete(i: { userId: string; actionId: string; via: ConfirmedVia }):
    Promise<{ ok: true; restoreUntil: string } | LifecycleFail> {
    const row = await this.actions.claim(i.userId, i.actionId, i.via);
    if (!row || row.kind !== 'delete' || !row.product_id) {
      if (row) await this.actions.release(row.id, row.result ?? {});
      return { ok: false, reason: 'not_pending', message: 'Карточка уже закрыта или срок вышел' };
    }
    let r: any;
    try {
      r = await this.pg.query(
        `UPDATE products
            SET archived_at = now(), purge_after = now() + make_interval(days => $3),
                status = 'archived', first_prompt = NULL, first_prompt_channel = NULL
          WHERE id = $1 AND user_id = $2 AND archived_at IS NULL AND status <> 'provisioning'
          RETURNING purge_after`,
        [row.product_id, i.userId, DELETE_GRACE_DAYS],
      );
    } catch (e: any) {
      // Обрыв прямо на архивации (не «0 строк» — это не исключение, оно
      // ниже) — без release карточка умерла бы в working навсегда: claim и
      // cancel требуют status='pending'. Текст — общий, сырая ошибка в лог.
      this.logger.warn(`completeDelete ${row.id} упал на архивации: ${e?.stack ?? e?.message ?? e}`);
      const message = 'Не получилось — попробуйте ещё раз позже';
      await this.actions.release(row.id, { error: message });
      return { ok: false, reason: 'failed', message };
    }
    if (!r.rows[0]) {
      await this.actions.finish(row.id, 'failed', { error: 'Продукт уже удалён или ещё заводится' });
      return { ok: false, reason: 'gone', message: 'Продукт уже удалён или ещё заводится' };
    }
    try {
      // Продукт уже архивирован — отказ здесь не должен выглядеть отказом
      // удаления (оно случилось) и не должен оставить карточку в working:
      // sleepDeletedTick (60 с) всё равно переставит сон архивному продукту
      // без сна, так что неудавшийся INSERT не теряет его навсегда — только
      // лог и переход к finish(done).
      //
      // Пробуждение и прочее в очереди архивному не выдаются и заняли бы
      // место единственного активного задания — снимаем.
      await this.pg.query(
        `UPDATE product_provision_jobs SET status = 'failed', error = 'снято удалением', finished_at = now()
          WHERE product_id = $1 AND status = 'queued' AND kind <> 'sleep'`,
        [row.product_id],
      );
      await this.queueSleepForDeleted(row.product_id);
    } catch (e: any) {
      this.logger.warn(`completeDelete ${row.id}: снятие заданий или постановка сна не прошли — доделает тик: ${e?.stack ?? e?.message ?? e}`);
    }
    const restoreUntil = new Date(r.rows[0].purge_after).toISOString();
    await this.actions.finish(row.id, 'done', { restoreUntil });
    return { ok: true, restoreUntil };
  }

  /**
   * Сон удалённым, у кого ещё нет сна после удаления. Ждёт тишины правки, как
   * сон за неуплату: погашенный посреди правки контейнер убивает её молча.
   */
  async queueSleepForDeleted(productId?: string): Promise<number> {
    const r = await this.pg.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status)
       SELECT p.id, 'sleep', 'queued' FROM products p
        WHERE p.archived_at IS NOT NULL AND p.purged_at IS NULL AND p.status = 'archived'
          AND ($1::uuid IS NULL OR p.id = $1::uuid)
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.kind = 'sleep'
                             AND j.created_at >= p.archived_at AND j.status IN ('queued','running','done'))
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.status IN ('queued','running'))
          AND NOT EXISTS (SELECT 1 FROM product_turns t
                           WHERE t.product_id = p.id AND t.status IN ('queued','running')
                             AND COALESCE(t.last_progress_at, t.started_at, t.created_at) > now() - ${TURN_SILENCE_SQL})
       ON CONFLICT DO NOTHING
       RETURNING product_id`,
      [productId ?? null],
    );
    return r.rows.length;
  }

  sleepDeletedTick(): Promise<number> {
    return this.queueSleepForDeleted();
  }

  async restore(i: { userId: string; productId: string; channel: ActionChannel }):
    Promise<{ ok: true; status: 'sleeping' | 'blocked'; waking: boolean } | LifecycleFail> {
    const cur = await this.pg.query(
      `SELECT p.id, p.name, p.purge_after, p.block_reason,
              EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.product_id = p.id AND j.status = 'running') AS busy
         FROM products p
        WHERE p.id = $1 AND p.user_id = $2 AND p.archived_at IS NOT NULL AND p.purged_at IS NULL`,
      [i.productId, i.userId],
    );
    const p = cur.rows[0];
    if (!p) return { ok: false, reason: 'not_found', message: 'Удалённого продукта с таким именем нет' };
    if (new Date(p.purge_after) <= new Date()) return { ok: false, reason: 'expired', message: 'Срок возврата вышел' };
    if (p.busy) return { ok: false, reason: 'busy', message: 'Машина продукта сейчас занята — попробуйте через минуту' };
    try {
      await this.limits.assertCanCreate(i.userId, await this.isAdmin(i.userId));
    } catch (e: any) {
      const f = failOf(e, 'Нет места в пределе', this.logger);
      await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'failed', payload: { name: p.name }, result: { reason: f.reason, error: f.message } });
      return f;
    }
    // Сон удаления, ещё не выданный агенту, усыпил бы вернувшийся продукт.
    await this.pg.query(
      `UPDATE product_provision_jobs SET status = 'failed', error = 'снято возвратом', finished_at = now()
        WHERE product_id = $1 AND status = 'queued'`,
      [p.id],
    );
    let r: any;
    try {
      r = await this.pg.query(
        `UPDATE products
            SET archived_at = NULL, purge_after = NULL,
                status = CASE WHEN block_reason IS NOT NULL THEN 'blocked' ELSE 'sleeping' END,
                sleep_reason = CASE WHEN block_reason IS NULL AND paid_until <= now() THEN $3 ELSE sleep_reason END
          WHERE id = $1 AND user_id = $2 AND archived_at IS NOT NULL AND purged_at IS NULL AND purge_after > now()
          RETURNING status, paid_until > now() AS paid`,
        [p.id, i.userId, SLEEP_REASON_NO_TOKENS],
      );
    } catch (e: any) {
      // Токен бота этого (ещё архивного) продукта мог за время архива
      // перейти живому продукту: частичный UNIQUE products_tg_bot_live
      // смотрит только на archived_at IS NULL, и снятие архива здесь делает
      // строку живой — то есть второй живой строкой с тем же tg_bot_id.
      // completeDelete tg_bot_id с архивного продукта не снимает (он не
      // участвует в индексе, пока продукт архивный), поэтому гонка возможна
      // не на удалении, а именно здесь, на возврате.
      if (e?.code === '23505' && e?.constraint === 'products_tg_bot_live') {
        const message = 'Этот бот уже работает в другом продукте — удалённого не вернуть, пока его токен занят';
        await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'failed', payload: { name: p.name }, result: { reason: 'bot_in_use', error: message } });
        return { ok: false, reason: 'bot_in_use', message };
      }
      throw e;
    }
    const row = r.rows[0];
    if (!row) return { ok: false, reason: 'not_found', message: 'Удалённого продукта с таким именем нет' };
    let waking = false;
    if (row.status === 'sleeping' && row.paid) {
      // Оплаченный период ещё идёт — будим сами: подметальщик аренды будит
      // только тех, на кого хватает баланса на новый месяц.
      const w = await this.pg.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'wake', 'queued')
         ON CONFLICT DO NOTHING RETURNING product_id`,
        [p.id],
      );
      if (w.rows.length > 0) {
        waking = true;
      } else {
        // ON CONFLICT молчит не только на повторный клик здесь: RentService
        // (wakeTick) мог поставить 'wake' на этот же продукт между нашим
        // UPDATE products выше и этим INSERT, пока мы не держали продукт
        // архивным ни секунды лишней. `waking = false` в таком случае было
        // бы неправдой — задание уже в очереди, просто не нашим INSERT.
        const existing = await this.pg.query(
          `SELECT 1 FROM product_provision_jobs WHERE product_id = $1 AND kind = 'wake' AND status IN ('queued','running')`,
          [p.id],
        );
        waking = existing.rows.length > 0;
      }
    }
    await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'done', payload: { name: p.name }, result: { status: row.status, waking } });
    return { ok: true, status: row.status, waking };
  }

  /**
   * Откат правки. Отказы очереди правок (сон, блок, баланс) — броском, как у
   * enqueue: `this.turns.revert` внутри зовёт `enqueue`, и его отказы
   * (SLEEPING_REFUSAL → 402, BLOCKED_REFUSAL → 409, «Агент уже работает над
   * предыдущим запросом» → 409, «Недостаточно токенов» → 402, «Product not
   * found» → 404) здесь НЕ перехватываются и НЕ превращаются в LifecycleFail —
   * этот метод их прокидывает наверх как есть. Разбирает их вызывающий слой
   * инструмента (product-tool.service.ts, `refusal()`), который сопоставляет
   * текст с причиной для ассистента; здесь никакого try/catch нет намеренно,
   * а не по недосмотру.
   */
  async revert(i: { userId: string; productId: string; turnId?: string | null; channel: ActionChannel }):
    Promise<{ ok: true; turnId: string } | LifecycleFail> {
    let target = String(i.turnId ?? '').trim();
    if (!target) {
      const r = await this.pg.query(
        `SELECT id FROM product_turns
          WHERE product_id = $1 AND user_id = $2 AND status = 'done' AND sha_before IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [i.productId, i.userId],
      );
      target = r.rows[0]?.id ?? '';
      if (!target) return { ok: false, reason: 'no_turns', message: 'У продукта нет применённых правок, которые можно откатить' };
    }
    const turn = await this.turns.revert({ productId: i.productId, turnId: target, userId: i.userId, channel: i.channel === 'telegram' ? 'telegram' : 'web' });
    await this.actions.record({ userId: i.userId, productId: i.productId, kind: 'revert', channel: i.channel, status: 'done', payload: { turnId: target }, result: { newTurnId: turn.id } });
    return { ok: true, turnId: turn.id };
  }

  /** Первая правка продуктам, которые поднялись. Сбой одной не роняет остальные. */
  async firstPromptTick(): Promise<number> {
    const r = await this.pg.query(
      `WITH picked AS (
          SELECT id, user_id, first_prompt, first_prompt_channel FROM products
           WHERE first_prompt IS NOT NULL AND status = 'running' AND archived_at IS NULL
           ORDER BY created_at LIMIT 20
             FOR UPDATE SKIP LOCKED
       ), cleared AS (
          UPDATE products p SET first_prompt = NULL, first_prompt_channel = NULL
            FROM picked WHERE p.id = picked.id
       )
       SELECT * FROM picked`,
    );
    for (const row of r.rows) {
      try {
        await this.turns.enqueue({
          productId: row.id, userId: row.user_id, prompt: row.first_prompt,
          channel: row.first_prompt_channel === 'telegram' ? 'telegram' : 'web',
        });
      } catch (e: any) {
        // Та же форма извлечения текста, что в product-tool.service
        // (refusal): у HttpException это публичное поле `response`, а не
        // getResponse() — здесь нужен только текст для сравнения, не статус.
        const msg = typeof e?.response === 'string' ? e.response : (e?.response?.message ?? e?.message ?? '');
        if (msg === 'Агент уже работает над предыдущим запросом') {
          // Мьютекс хода занят кем-то другим (например, владелец поставил
          // правку руками до того, как первая правка добралась до своего
          // тика) — первая правка не потеряна, а отложена: CTE выше уже
          // обнулил first_prompt этой строки, и без возврата продукт навсегда
          // остался бы без своей первой правки. `first_prompt IS NULL` —
          // чтобы не затереть первую правку, которую между CTE и этим UPDATE
          // поставил кто-то ещё (повторное создание тем же именем).
          await this.pg.query(
            `UPDATE products SET first_prompt = $2, first_prompt_channel = $3 WHERE id = $1 AND first_prompt IS NULL`,
            [row.id, row.first_prompt, row.first_prompt_channel],
          );
          continue;
        }
        // Прочие отказы (сон, блок, нет токенов, продукт исчез) не лечатся
        // повтором на следующем тике — повтор занял бы его местом в LIMIT 20
        // бесконечно. Разбор причины — дело владельца или подписки, не тика.
        this.logger.warn(`первая правка продукта ${row.id} не поставлена: ${e?.message}`);
      }
    }
    return r.rows.length;
  }
}
