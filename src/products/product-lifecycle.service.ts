import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ProvisioningService } from './provisioning.service';
import { LimitsService } from './limits.service';
import { TurnsService, TURN_SILENCE_SQL } from './turns.service';
import { SLEEP_REASON_NO_TOKENS } from './rent.service';
import { ActionChannel, ConfirmedVia, DELETE_GRACE_DAYS, ProductActionsService } from './product-actions.service';
import { BotTokenCheck, checkBotToken } from './bot-token-check';
import { randomSuffix, siteSlugCandidates, slugWithSuffix } from './product-slug';
import { SecretsService } from './secrets.service';

// Срок возврата живёт в журнале (product-actions.service.ts) — одно число на
// оба места; отсюда реэкспорт для инструмента, Telegram и спек.
export { DELETE_GRACE_DAYS };
const NAME_MAX = 80;
/** Форма product_actions/product_turns.id. Та же маска, что в product-actions.service.ts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LifecycleFail = { ok: false; reason: string; message: string };

/**
 * Что записывается в снятую правку при удалении продукта. Видит ВЛАДЕЛЕЦ — в
 * истории правок, на месте результата (тот же приём, что у
 * block.service.TURN_KILLED_BY_BLOCK): без слова «удалён» он читал бы обычный
 * отказ раннера и искал поломку у себя.
 */
export const TURN_KILLED_BY_DELETE = 'Продукт удалён — правка не применена';

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
  /**
   * Продукты, о чьём потолке провалов сна уже предупредили. Не колонка и не
   * строка в журнале: предупреждение — разовая подсказка живому человеку в
   * логе, переживать перезапуск процесса ему незачем, а на поведение тика
   * (queueSleepForDeleted) множество не влияет вовсе.
   */
  private warnedSleepCap = new Set<string>();

  constructor(
    private readonly pg: PgService,
    private readonly provisioning: ProvisioningService,
    private readonly limits: LimitsService,
    private readonly turns: TurnsService,
    private readonly actions: ProductActionsService,
    // I2, часть 2: бэкафилл tg_bot_id. SecretsService — чтобы расшифровать
    // BOT_TOKEN боту, которому ProvisioningService.create не смог дозвониться
    // до Telegram при заведении (reason 'unreachable') и оставил tg_bot_id
    // пустым. Без неё backfillBotIdsTick не собирается вовсе — токен лежит
    // только в зашифрованном виде.
    private readonly secrets: SecretsService,
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

    // I2, часть 2: раз в 10 минут — донести tg_bot_id ботам Студии, которым
    // ProvisioningService.create не дозвонился до Telegram при заведении.
    // Сам тик бьёт по строке не чаще раза в сутки (tg_bot_checked_at) — 10
    // минут здесь только про то, как часто процесс оглядывается на очередь,
    // а не про то, как часто один бот получает повторный getMe.
    const backfillBotIds = setInterval(() => void this.safe('бэкафилл tg_bot_id', () => this.backfillBotIdsTick()), 600_000);
    backfillBotIds.unref?.();
    this.timers.push(backfillBotIds);
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
    Promise<{ ok: true; productId: string; slug: string; domain: string | null; freeMonth: boolean } | LifecycleFail> {
    const name = cleanName(i.name);
    if (!name) return { ok: false, reason: 'bad_name', message: `Имя продукта — от 1 до ${NAME_MAX} знаков` };
    const isAdmin = await this.isAdmin(i.userId);
    let lastError: any = null;
    let created: { productId: string; slug: string; freeMonth: boolean } | null = null;
    for (const slug of siteSlugCandidates(name, this.suffix)) {
      try {
        const { productId, freeMonth } = await this.provisioning.create({ userId: i.userId, name, slug, kind: 'site', secrets: {}, isAdmin });
        created = { productId, slug, freeMonth };
        break;
      } catch (e: any) {
        lastError = e;
        if (e instanceof HttpException && e.getStatus() === 409) continue; // слаг занят — следующий кандидат
        break;
      }
    }
    if (!created) {
      const f = failOf(lastError, 'Сайт не создан', this.logger);
      await this.actions.record({ userId: i.userId, productId: null, kind: 'create_site', channel: i.channel, status: 'failed', payload: { name }, result: { reason: f.reason, error: f.message } });
      return f;
    }
    // Сайт уже создан — он СУЩЕСТВУЕТ и работает, что бы ни случилось дальше.
    // Раньше первая правка, чтение домена и запись в журнал жили внутри
    // того же try, что и create(): обрыв любого из них ловился тем же catch,
    // что занятый слаг, и превращал успех в failed. Человек видел отказ,
    // пробовал тем же именем снова и заводил ВТОРОЙ сайт поверх первого.
    // Приём тот же, что у completeCreateBot: продукт важнее хвостов, лог
    // без секретов, итог всё равно ok (domain может остаться null).
    let domain: string | null = null;
    try {
      await this.setFirstPrompt(created.productId, i.prompt, i.channel);
      const d = await this.pg.query(`SELECT domain FROM products WHERE id = $1`, [created.productId]);
      domain = d.rows[0]?.domain ?? null;
      await this.actions.record({ userId: i.userId, productId: created.productId, kind: 'create_site', channel: i.channel, status: 'done', payload: { name, slug: created.slug } });
    } catch (e: any) {
      this.logger.warn(`сайт ${created.productId} создан, но первая правка/домен/журнал не доделаны: ${e?.stack ?? e?.message ?? e}`);
    }
    return { ok: true, productId: created.productId, slug: created.slug, domain, freeMonth: created.freeMonth };
  }

  async openCreateBot(i: { userId: string; name: unknown; prompt?: unknown; channel: ActionChannel; turn: string | null }):
    Promise<{ ok: true; actionId: string; expiresAt: string } | LifecycleFail> {
    const name = cleanName(i.name);
    if (!name) return { ok: false, reason: 'bad_name', message: `Имя бота — от 1 до ${NAME_MAX} знаков` };
    // M8: предел — до открытия карточки, а не после того, как человек введёт
    // в неё токен бота и ключи сервисов (completeCreateBot проверяет его
    // уже постфактум, на create()). Отбитый предел после ввода токена —
    // потраченное доверие: человек отдал секрет боту, который не завёлся бы
    // всё равно.
    try {
      await this.limits.assertCanCreate(i.userId, await this.isAdmin(i.userId));
    } catch (e: any) {
      return failOf(e, 'Нет места в пределе', this.logger);
    }
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
    Promise<{ ok: true; productId: string; freeMonth: boolean } | LifecycleFail> {
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
      const { productId, freeMonth } = await this.provisioning.create({
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
      // freeMonth — только теперь, по итогу create(): до завершения
      // карточки (M8, открытие action заранее) этого не знал никто. Кладём
      // его в result карточки, а не только в возврат этого метода: вызывающий
      // контроллер (product-actions.controller.ts) результат completeCreateBot
      // не читает вовсе — исход человек узнаёт отдельным запросом
      // (action="status" / GET product-actions/:id), и без этого поля там
      // ассистент не смог бы сказать, попал ли бот в бесплатный месяц.
      await this.actions.finish(row.id, 'done', { productId, botUsername: check.username, freeMonth }, productId);
      return { ok: true, productId, freeMonth };
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
      `SELECT id, name, slug, kind, status, block_reason FROM products WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [i.productId, i.userId],
    );
    const p = r.rows[0];
    if (!p) return { ok: false, reason: 'not_found', message: 'Такого продукта нет' };
    if (p.status === 'provisioning') {
      return { ok: false, reason: 'provisioning', message: 'Продукт ещё заводится — удалить его можно через минуту' };
    }
    // I4: удаление блокированного продукта освободило бы его слот в пределе
    // (assertCanCreate считает по archived_at, не по block_reason) и дало
    // человеку способ обойти блокировку — создать тем же именем новый
    // продукт вместо того, который остановил администратор.
    if (p.block_reason !== null) {
      return { ok: false, reason: 'blocked', message: 'Продукт остановлен администратором — удалить его можно через поддержку' };
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
        // prevStatus — статус ДО архивации, а не текущий ('archived'),
        // который эта же команда ставит ниже: без него возврат не отличил бы
        // «спал за неуплату» от «вернуть туда, где и было сломано» (M3) —
        // продукту, удалённому в failed, пополнение баланса не поможет, и
        // sleeping со sleep_reason «нет токенов» было бы неправдой владельцу.
        // old — отдельным CTE, а не чтением уже обновлённой строки: RETURNING
        // видит только ПОСЛЕ своего же SET. FOR UPDATE в old НЕ ставить —
        // измерено на живой PostgreSQL 16: с ним пара CTE+UPDATE одной строки
        // отдаёт prev_status пустым (EvalPlanQual перечитывает старую строку
        // по новой версии, которую только что создал тот же оператор). Без
        // FOR UPDATE конкурентности тут и не нужно: CTE читает снимок ДО
        // изменений того же оператора, а блокировка строки — у самого UPDATE.
        `WITH old AS (SELECT status FROM products WHERE id = $1 AND user_id = $2)
         UPDATE products
            SET archived_at = now(), purge_after = now() + make_interval(days => $3),
                status = 'archived', first_prompt = NULL, first_prompt_channel = NULL
          WHERE id = $1 AND user_id = $2 AND archived_at IS NULL AND status <> 'provisioning'
          RETURNING purge_after, (SELECT status FROM old) AS prev_status`,
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
      // sleepDeletedTick (60 с) доснимет застрявшие задания и поставит сон
      // архивному продукту без сна, так что оборванный шаг не теряет его
      // навсегда — только лог и переход к finish(done).
      //
      // Пробуждение и прочее в очереди архивному не выдаются и заняли бы
      // место единственного активного задания — снимаем.
      await this.pg.query(
        `UPDATE product_provision_jobs SET status = 'failed', error = 'снято удалением', finished_at = now()
          WHERE product_id = $1 AND status = 'queued' AND kind <> 'sleep'`,
        [row.product_id],
      );
      // Правка продукта — туда же, тем же приёмом, что у блокировки
      // администратора (block.service.ts, killed_turns): 'queued' наравне с
      // 'running', без оглядки на признаки жизни. Без этого queued-правка
      // держит product_turns_one_active (delete её не трогал), а
      // queueSleepForDeleted ждёт её тишины (TURN_SILENCE_SQL) вместо
      // немедленного сна; running-правка молча доедет после возврата, когда
      // продукт снова живой, — владелец получит правку, которую не просил
      // применять именно сейчас.
      await this.pg.query(
        `UPDATE product_turns SET status = 'failed', error = $2, finished_at = now()
          WHERE product_id = $1 AND status IN ('queued','running')`,
        [row.product_id, TURN_KILLED_BY_DELETE],
      );
      await this.queueSleepForDeleted(row.product_id);
    } catch (e: any) {
      this.logger.warn(`completeDelete ${row.id}: снятие заданий или постановка сна не прошли — доделает тик: ${e?.stack ?? e?.message ?? e}`);
    }
    const restoreUntil = new Date(r.rows[0].purge_after).toISOString();
    await this.actions.finish(row.id, 'done', { restoreUntil, prevStatus: r.rows[0].prev_status ?? null });
    return { ok: true, restoreUntil };
  }

  /**
   * Сон удалённым, у кого ещё нет сна после удаления. Ждёт тишины правки, как
   * сон за неуплату: погашенный посреди правки контейнер убивает её молча.
   */
  async queueSleepForDeleted(productId?: string): Promise<number> {
    // Потолок — 3 провала сна подряд ПОСЛЕ этой архивации (старые провалы
    // прошлого цикла архив/возврат не считаются — j.created_at >= p.archived_at,
    // тот же приём, что у соседней проверки «сон уже стоял»). Без потолка
    // тик каждую минуту заново ставит сон, который стабильно не выполняется
    // (например, машина продукта недостижима), и так все 30 дней возврата —
    // тупик только для глаз: ни кабинет, ни «Сайты и боты» не показывают
    // product_provision_jobs вовсе, только лог.
    const capped = await this.pg.query(
      `SELECT p.id FROM products p
        WHERE p.archived_at IS NOT NULL AND p.purged_at IS NULL AND p.status = 'archived'
          AND ($1::uuid IS NULL OR p.id = $1::uuid)
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.status IN ('queued','running'))
          AND (SELECT count(*) FROM product_provision_jobs j
                WHERE j.product_id = p.id AND j.kind = 'sleep' AND j.status = 'failed'
                  AND j.created_at >= p.archived_at) >= 3`,
      [productId ?? null],
    );
    for (const row of capped.rows) {
      // Один раз на процесс, а не на каждый тик: иначе лог заполняется той же
      // строкой каждую минуту все оставшиеся дни возврата.
      if (this.warnedSleepCap.has(row.id)) continue;
      this.warnedSleepCap.add(row.id);
      this.logger.warn(`сон удалённого продукта ${row.id} не ставится: 3 провала подряд, нужен ручной разбор`);
    }

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
          AND (SELECT count(*) FROM product_provision_jobs j
                WHERE j.product_id = p.id AND j.kind = 'sleep' AND j.status = 'failed'
                  AND j.created_at >= p.archived_at) < 3
          -- FOR UPDATE OF p — М2: восстанавливающая транзакция (restore())
          -- держит эту же строку заблокированной с SELECT … FOR UPDATE до
          -- своего COMMIT. Без локатора здесь этот SELECT читал бы снимок
          -- ДО возврата (archived_at ещё не NULL) и всё равно вставил бы
          -- сон — лок дожидается конца чужой транзакции и ПЕРЕЧИТЫВАЕТ
          -- строку (EvalPlanQual), так что к этому моменту archived_at уже
          -- NULL, и WHERE выше её не пропускает.
          FOR UPDATE OF p
       ON CONFLICT DO NOTHING
       RETURNING product_id`,
      [productId ?? null],
    );
    return r.rows.length;
  }

  async sleepDeletedTick(): Promise<number> {
    // Снятие заданий в completeDelete могло оборваться. Тогда queued-задание
    // архивного продукта не выдаётся никому (claimJob архивному отдаёт только
    // sleep) и вечно загораживает сон: queueSleepForDeleted ждёт пустой
    // очереди. Доснимаем здесь. Возврат снимает архив раньше, чем ставит своё
    // пробуждение, — его задание сюда не попадает.
    await this.pg.query(
      `UPDATE product_provision_jobs j SET status = 'failed', error = 'снято удалением', finished_at = now()
         FROM products p
        WHERE j.product_id = p.id AND p.archived_at IS NOT NULL
          AND j.status = 'queued' AND j.kind <> 'sleep'`,
    );
    return this.queueSleepForDeleted();
  }

  async restore(i: { userId: string; productId: string; channel: ActionChannel }):
    Promise<{ ok: true; status: 'sleeping' | 'blocked' | 'failed'; waking: boolean } | LifecycleFail> {
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
    // M2: снятие очереди и снятие архива — в ОДНОЙ транзакции, с FOR UPDATE
    // на строке продукта В САМОМ НАЧАЛЕ, а не только на UPDATE products ниже.
    // Без этого между «снять очередь» и «снять архив» помещается чужой
    // коммит: минутный тик queueSleepForDeleted мог вставить НОВЫЙ 'sleep',
    // которого снятие очереди уже не увидело, — и этот сон переживал возврат.
    // queueSleepForDeleted со своей стороны блокируется на той же строке
    // (FOR UPDATE OF p в его INSERT…SELECT) — иначе захват здесь никого не
    // ждал бы, и тик всё равно читал бы archived_at мимо этой транзакции.
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT 1 FROM products
          WHERE id = $1 AND user_id = $2 AND archived_at IS NOT NULL AND purged_at IS NULL
          FOR UPDATE`,
        [p.id, i.userId],
      );
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found', message: 'Удалённого продукта с таким именем нет' };
      }

      // Сон удаления, ещё не выданный агенту, усыпил бы вернувшийся продукт.
      await client.query(
        `UPDATE product_provision_jobs SET status = 'failed', error = 'снято возвратом', finished_at = now()
          WHERE product_id = $1 AND status = 'queued'`,
        [p.id],
      );
      // M3: статус ДО удаления — из последнего завершённого действия delete
      // по этому продукту (completeDelete кладёт его туда же, куда и
      // restoreUntil). Продукт, удалённый сломанным (failed), вернувшись
      // sleeping, молча начал бы списывать аренду за контейнер, который
      // никогда не работал, — пополнение баланса его не починит.
      const prevR = await client.query(
        `SELECT result->>'prevStatus' AS prev_status FROM product_actions
          WHERE product_id = $1 AND kind = 'delete' AND status = 'done'
          ORDER BY created_at DESC LIMIT 1`,
        [p.id],
      );
      const prevStatus: string | null = prevR.rows[0]?.prev_status ?? null;

      let r: any;
      try {
        r = await client.query(
          `UPDATE products
              SET archived_at = NULL, purge_after = NULL,
                  status = CASE WHEN block_reason IS NOT NULL THEN 'blocked' WHEN $4 = 'failed' THEN 'failed' ELSE 'sleeping' END,
                  sleep_reason = CASE WHEN block_reason IS NULL AND $4 IS DISTINCT FROM 'failed' AND paid_until <= now() THEN $3 ELSE sleep_reason END
            WHERE id = $1 AND user_id = $2 AND archived_at IS NOT NULL AND purged_at IS NULL AND purge_after > now()
            RETURNING status, paid_until > now() AS paid`,
          [p.id, i.userId, SLEEP_REASON_NO_TOKENS, prevStatus],
        );
      } catch (e: any) {
        // Токен бота этого (ещё архивного) продукта мог за время архива
        // перейти живому продукту: частичный UNIQUE products_tg_bot_live
        // смотрит только на archived_at IS NULL, и снятие архива здесь
        // делает строку живой — то есть второй живой строкой с тем же
        // tg_bot_id. completeDelete tg_bot_id с архивного продукта не
        // снимает (он не участвует в индексе, пока продукт архивный),
        // поэтому гонка возможна не на удалении, а именно здесь, на
        // возврате.
        if (e?.code === '23505' && e?.constraint === 'products_tg_bot_live') {
          await client.query('ROLLBACK');
          const message = 'Этот бот уже работает в другом продукте — удалённого не вернуть, пока его токен занят';
          await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'failed', payload: { name: p.name }, result: { reason: 'bot_in_use', error: message } });
          return { ok: false, reason: 'bot_in_use', message };
        }
        throw e;
      }
      const row = r.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found', message: 'Удалённого продукта с таким именем нет' };
      }
      let waking = false;
      if (row.status === 'sleeping' && row.paid) {
        // Оплаченный период ещё идёт — будим сами: подметальщик аренды будит
        // только тех, на кого хватает баланса на новый месяц.
        const w = await client.query(
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
          const existing = await client.query(
            `SELECT 1 FROM product_provision_jobs WHERE product_id = $1 AND kind = 'wake' AND status IN ('queued','running')`,
            [p.id],
          );
          waking = existing.rows.length > 0;
        }
      }
      await client.query('COMMIT');
      await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'done', payload: { name: p.name }, result: { status: row.status, waking } });
      return { ok: true, status: row.status, waking };
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
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
  /** Отказ отката — в журнал как failed. Лучшее усилие: сбой записи самого журнала не должен топить отказ, который он описывает. */
  private async recordRevertRefusal(i: { userId: string; productId: string; channel: ActionChannel }, target: string, reason: string, error: string): Promise<void> {
    try {
      await this.actions.record({ userId: i.userId, productId: i.productId, kind: 'revert', channel: i.channel, status: 'failed', payload: target ? { turnId: target } : {}, result: { reason, error } });
    } catch (e: any) {
      this.logger.warn(`revert ${i.productId}: отказ (${reason}) не записан в журнал: ${e?.message}`);
    }
  }

  async revert(i: { userId: string; productId: string; turnId?: string | null; channel: ActionChannel }):
    Promise<{ ok: true; turnId: string } | LifecycleFail> {
    let target = String(i.turnId ?? '').trim();
    if (target && !UUID_RE.test(target)) {
      // M6: turnId модель передаёт с чужих слов — не угадала форму, не
      // переврала базу. Без этой проверки raw-запрос в turns.revert уронил
      // бы «invalid input syntax for type uuid» прямо в ответ ассистенту.
      await this.recordRevertRefusal(i, target, 'bad_turn', 'Такой правки у продукта нет');
      return { ok: false, reason: 'bad_turn', message: 'Такой правки у продукта нет' };
    }
    if (!target) {
      const r = await this.pg.query(
        `SELECT id FROM product_turns
          WHERE product_id = $1 AND user_id = $2 AND status = 'done' AND sha_before IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [i.productId, i.userId],
      );
      target = r.rows[0]?.id ?? '';
      if (!target) {
        const message = 'У продукта нет применённых правок, которые можно откатить';
        await this.recordRevertRefusal(i, '', 'no_turns', message);
        return { ok: false, reason: 'no_turns', message };
      }
    }
    let turn: { id: string };
    try {
      turn = await this.turns.revert({ productId: i.productId, turnId: target, userId: i.userId, channel: i.channel === 'telegram' ? 'telegram' : 'web' });
    } catch (e: any) {
      // M7: отказы очереди правок (сон/блок/занят/нет токенов/не найден)
      // ВСЁ ЕЩЁ долетают до вызывающего БРОСКОМ, как документировано выше, —
      // этот catch ничего не решает за вызывающего (product-tool.service.ts,
      // refusal()), только дописывает строку в журнал: без неё отказ отката
      // не оставлял следа вовсе, в отличие от удаления и возврата.
      const msg = typeof e?.response === 'string' ? e.response : (e?.response?.message ?? e?.message ?? String(e));
      await this.recordRevertRefusal(i, target, 'refused', msg);
      throw e;
    }
    // Итог отката — НЕ 'done' с полным результатом: исход (reverted/done/
    // failed) живёт в product_turns у СЛЕДУЮЩЕГО хода (turn.id), который
    // только поставлен в очередь. queued:true — явная метка «не путай со
    // статусом отменённого хода», а не забытое поле.
    await this.actions.record({ userId: i.userId, productId: i.productId, kind: 'revert', channel: i.channel, status: 'done', payload: { turnId: target }, result: { turnId: turn.id, queued: true } });
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

  /**
   * I2, часть 2: доносит tg_bot_id ботам Студии, которым
   * ProvisioningService.create не дозвонился до Telegram при заведении
   * (`reason: 'unreachable'`) — без этого тика такой бот остаётся без
   * tg_bot_id навсегда, и партиционный UNIQUE products_tg_bot_live его не
   * видит вовсе: второй бот с тем же токеном заводится как ни в чём не
   * бывало и отнимает у первого обновления Telegram молча.
   *
   * `tg_bot_checked_at < now() - interval '1 day'` — раз в сутки на строку, а
   * не на каждый тик: getMe — внешняя сеть, а подавляющее большинство строк
   * здесь — боты, которым Telegram ответил `rejected`/`bad_form` при
   * заведении и ответит так же сейчас; долбить его каждые 10 минут ради них
   * незачем.
   *
   * Расшифрованный токен живёт ТОЛЬКО в локальной переменной `token` — в лог
   * и в параметры SQL он не попадает ни при успехе, ни при отказе: имя
   * колонки tg_bot_checked_at само по себе не секрет, а токен в логе был бы
   * готовым доступом к боту для каждого, кто читает лог процесса (канарейка —
   * provisioning.integration.spec.ts M11, зеркало здесь — спек этого файла).
   */
  async backfillBotIdsTick(): Promise<number> {
    const r = await this.pg.query(
      `SELECT id, secrets_encrypted FROM products
        WHERE kind = 'bot' AND archived_at IS NULL AND tg_bot_id IS NULL
          AND secrets_encrypted IS NOT NULL
          AND (tg_bot_checked_at IS NULL OR tg_bot_checked_at < now() - interval '1 day')
        ORDER BY created_at LIMIT 20`,
    );
    for (const row of r.rows) {
      let token = '';
      try {
        const box = this.secrets.decrypt(row.secrets_encrypted, row.id);
        token = String(box.BOT_TOKEN ?? '').trim();
      } catch (e: any) {
        this.logger.warn(`бэкафилл tg_bot_id ${row.id}: секреты не расшифровались (${e?.message})`);
      }
      if (!token) {
        await this.pg.query(`UPDATE products SET tg_bot_checked_at = now() WHERE id = $1`, [row.id]);
        continue;
      }
      const check = await this.checkBot(token);
      // `check.ok === false`, а не `!check.ok` — та же ловушка strictNullChecks,
      // что в completeCreateBot выше и в provisioning.service.ts (I2 часть 1).
      if (check.ok === false) {
        // bad_form/rejected — токен сам живым не станет; unreachable —
        // Telegram снова не ответил. Разница не меняет действие тика: обе
        // ветки просто сдвигают tg_bot_checked_at на сутки вперёд.
        await this.pg.query(`UPDATE products SET tg_bot_checked_at = now() WHERE id = $1`, [row.id]);
        continue;
      }
      try {
        await this.pg.query(
          `UPDATE products SET tg_bot_id = $2, tg_bot_checked_at = now() WHERE id = $1 AND tg_bot_id IS NULL`,
          [row.id, check.id],
        );
      } catch (e: any) {
        if (e?.code === '23505' && e?.constraint === 'products_tg_bot_live') {
          // Пока этот бот ждал бэкафилла, его токен занял ДРУГОЙ живой
          // продукт (обычным заведением или более ранней строкой этого же
          // тика) — именами продуктов, а не токеном: лог читает человек, а
          // не Telegram.
          const other = await this.pg.query(
            `SELECT id FROM products WHERE tg_bot_id = $1 AND archived_at IS NULL AND id <> $2 LIMIT 1`,
            [check.id, row.id],
          );
          this.logger.warn(
            `бэкафилл tg_bot_id: продукт ${row.id} и продукт ${other.rows[0]?.id ?? '?'} делят один токен бота — второму tg_bot_id не проставлен`,
          );
          await this.pg.query(`UPDATE products SET tg_bot_checked_at = now() WHERE id = $1`, [row.id]);
          continue;
        }
        throw e;
      }
    }
    return r.rows.length;
  }
}
