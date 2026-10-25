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

/** Отказ заведения и прочих сервисов — человеческим текстом и кодом причины. */
function failOf(e: any, fallback: string): LifecycleFail {
  const status = e instanceof HttpException ? e.getStatus() : 0;
  const body: any = e instanceof HttpException ? e.getResponse() : null;
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
    this.timers.push(setInterval(() => void this.safe('первая правка', () => this.firstPromptTick()), 30_000));
    this.timers.push(setInterval(() => void this.safe('сон удалённых', () => this.sleepDeletedTick()), 60_000));
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
    const f = failOf(lastError, 'Сайт не создан');
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
    const busy = await this.pg.query(`SELECT 1 FROM products WHERE tg_bot_id = $1 AND archived_at IS NULL LIMIT 1`, [check.id]);
    if (busy.rows.length) {
      const message = 'Этот бот уже работает в другом продукте — создайте в @BotFather нового бота';
      await this.actions.release(row.id, { error: message, field: 'BOT_TOKEN' });
      return { ok: false, reason: 'bot_in_use', message };
    }
    const name = String(row.payload?.name ?? '').trim();
    try {
      const { productId } = await this.provisioning.create({
        userId: i.userId, name, slug: slugWithSuffix(name, this.suffix(), 'bot'), kind: 'bot', secrets, isAdmin: await this.isAdmin(i.userId),
      });
      await this.pg.query(`UPDATE products SET tg_bot_id = $2 WHERE id = $1`, [productId, check.id]);
      await this.setFirstPrompt(productId, row.payload?.prompt, row.channel);
      await this.actions.finish(row.id, 'done', { productId, botUsername: check.username }, productId);
      return { ok: true, productId };
    } catch (e: any) {
      const f = failOf(e, 'Бот не создан');
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
    const r = await this.pg.query(
      `UPDATE products
          SET archived_at = now(), purge_after = now() + make_interval(days => $3),
              status = 'archived', first_prompt = NULL, first_prompt_channel = NULL
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL AND status <> 'provisioning'
        RETURNING purge_after`,
      [row.product_id, i.userId, DELETE_GRACE_DAYS],
    );
    if (!r.rows[0]) {
      await this.actions.finish(row.id, 'failed', { error: 'Продукт уже удалён или ещё заводится' });
      return { ok: false, reason: 'gone', message: 'Продукт уже удалён или ещё заводится' };
    }
    // Пробуждение и прочее в очереди архивному не выдаются и заняли бы место
    // единственного активного задания — снимаем.
    await this.pg.query(
      `UPDATE product_provision_jobs SET status = 'failed', error = 'снято удалением', finished_at = now()
        WHERE product_id = $1 AND status = 'queued' AND kind <> 'sleep'`,
      [row.product_id],
    );
    await this.queueSleepForDeleted(row.product_id);
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
      const f = failOf(e, 'Нет места в пределе');
      await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'failed', payload: { name: p.name }, result: { reason: f.reason, error: f.message } });
      return f;
    }
    // Сон удаления, ещё не выданный агенту, усыпил бы вернувшийся продукт.
    await this.pg.query(
      `UPDATE product_provision_jobs SET status = 'failed', error = 'снято возвратом', finished_at = now()
        WHERE product_id = $1 AND status = 'queued'`,
      [p.id],
    );
    const r = await this.pg.query(
      `UPDATE products
          SET archived_at = NULL, purge_after = NULL,
              status = CASE WHEN block_reason IS NOT NULL THEN 'blocked' ELSE 'sleeping' END,
              sleep_reason = CASE WHEN block_reason IS NULL AND paid_until <= now() THEN $3 ELSE sleep_reason END
        WHERE id = $1 AND user_id = $2 AND archived_at IS NOT NULL AND purged_at IS NULL AND purge_after > now()
        RETURNING status, paid_until > now() AS paid`,
      [p.id, i.userId, SLEEP_REASON_NO_TOKENS],
    );
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
      waking = w.rows.length > 0;
    }
    await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'done', payload: { name: p.name }, result: { status: row.status, waking } });
    return { ok: true, status: row.status, waking };
  }

  /** Откат правки. Отказы очереди правок (сон, блок, баланс) — броском, как у enqueue. */
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
        this.logger.warn(`первая правка продукта ${row.id} не поставлена: ${e?.message}`);
      }
    }
    return r.rows.length;
  }
}
