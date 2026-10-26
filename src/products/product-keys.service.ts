import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { BotTokenCheck, checkBotToken } from './bot-token-check';
import { ActionChannel, ActionRow, ConfirmedVia, ProductActionsService } from './product-actions.service';
import { isReservedSecretName, secretsProblem } from './secret-rules';
import { SecretsService } from './secrets.service';

export type KeysFail = { ok: false; reason: string; message: string };

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Отказ по состоянию продукта — один на открытие и на отправку: продукт мог
 * уснуть или попасть под блокировку, пока карточка ждала нажатия.
 */
function statusRefusal(p: { status: string; block_reason: string | null }): KeysFail | null {
  if (p.block_reason !== null || p.status === 'blocked') {
    return { ok: false, reason: 'blocked', message: 'Продукт остановлен администратором — ключи меняются через поддержку' };
  }
  if (p.status === 'sleeping') {
    return { ok: false, reason: 'sleeping', message: 'Продукт спит: не хватило токенов на аренду. Ключи меняются у работающего продукта — пополните баланс, он проснётся сам' };
  }
  if (p.status === 'provisioning') {
    return { ok: false, reason: 'provisioning', message: 'Продукт ещё заводится — ключи можно сменить через минуту' };
  }
  if (p.status === 'failed') {
    return { ok: false, reason: 'failed_product', message: 'Продукт не завёлся — сначала его нужно завести заново' };
  }
  if (p.status !== 'running' && p.status !== 'degraded') {
    return { ok: false, reason: 'unavailable', message: 'Продукт сейчас недоступен' };
  }
  return null;
}

/**
 * Ключи владельца из коробки продукта — без имён, ставших занятыми платформой
 * ПОСЛЕ заведения (OWNER_TG_ID — очередь 2, префиксы вроде DOTENV_). Такой
 * ключ агент машины не даст ни оставить в новом наборе (validateSecrets), ни
 * снять (validateDropNames) — и продукт с ним не смог бы сменить ключи
 * никогда. Поэтому он не показывается в карточке, не уходит агенту ни в
 * наборе, ни в снимаемых (переменная остаётся в контейнере «неизвестной», а
 * платформенный OWNER_TG_ID агент всё равно ставит поверх) и выпадает из
 * коробки в базе при первой же смене.
 */
function ownerKeys(all: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(all).filter(([k]) => !isReservedSecretName(k)));
}

/**
 * Текст исключения для лога. Сообщение SyntaxError (JSON.parse тела
 * расшифрованной коробки) в новых Node цитирует кусок разбираемого текста —
 * то есть значения ключей; его в лог не кладём (тот же приём, что у выдачи
 * rekey в provisioning.service.ts).
 */
function safeError(e: any): string {
  return e instanceof SyntaxError ? 'тело коробки не JSON' : String(e?.message ?? e).slice(0, 200);
}

/**
 * Смена ключей владельца карточкой (очередь 2). Открывает карточку с ИМЕНАМИ
 * текущих ключей и принимает её отправку: проверяет новый набор теми же
 * правилами, что заведение, шифрует его в коробку карточки и одним
 * оператором ставит задание rekey агенту машины. Ключи в базе продукта
 * меняются только отчётом агента об успехе (ProvisioningService.completeRekeyJob,
 * он же пишет tgBotId из payload в products.tg_bot_id).
 *
 * Значения ключей живут здесь только в локальных переменных: в payload и
 * result — имена, в логе — ничего от значений, в ответе — ничего.
 */
@Injectable()
export class ProductKeysService {
  private readonly logger = new Logger(ProductKeysService.name);
  /** Поле, а не прямой вызов: тесты подменяют Telegram (тот же приём, что у lifecycle). */
  private checkBot: (token: string) => Promise<BotTokenCheck> = (t) => checkBotToken(t);

  constructor(
    private readonly pg: PgService,
    private readonly actions: ProductActionsService,
    private readonly secrets: SecretsService,
  ) {}

  async open(i: { userId: string; productId: string; channel: ActionChannel; turn: string | null }):
    Promise<{ ok: true; actionId: string; expiresAt: string; keyNames: string[] } | KeysFail> {
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, status, block_reason, secrets_encrypted FROM products
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [i.productId, i.userId],
    );
    const p = r.rows[0];
    if (!p) return { ok: false, reason: 'not_found', message: 'Такого продукта нет' };
    const refusal = statusRefusal(p);
    if (refusal) return refusal;
    let keyNames: string[];
    try {
      keyNames = p.secrets_encrypted ? Object.keys(ownerKeys(this.secrets.decrypt(p.secrets_encrypted, p.id))).sort() : [];
    } catch (e: any) {
      this.logger.error(`ключи продукта ${p.id} не расшифровались: ${safeError(e)}`);
      return { ok: false, reason: 'failed', message: 'Ключи продукта сейчас не читаются — напишите в поддержку' };
    }
    const { id, expiresAt } = await this.actions.open({
      userId: i.userId, productId: p.id, kind: 'keys', channel: i.channel, turn: i.turn,
      payload: { name: p.name, slug: p.slug, productKind: p.kind, keyNames },
    });
    return { ok: true, actionId: id, expiresAt, keyNames };
  }

  async complete(i: { userId: string; actionId: string; set: unknown; remove: unknown; via: ConfirmedVia }):
    Promise<{ ok: true; queued: true } | KeysFail> {
    const row = await this.actions.claim(i.userId, i.actionId, i.via);
    if (!row || row.kind !== 'keys' || !row.product_id) {
      if (row) await this.actions.release(row.id, row.result ?? {});
      return { ok: false, reason: 'not_pending', message: 'Карточка уже закрыта или срок вышел' };
    }
    try {
      return await this.submit(row, i);
    } catch (e: any) {
      // Непонятная ошибка между claim и исходом — без release карточка умерла
      // бы в working (claim и cancel требуют pending). В лог — только текст
      // ошибки: параметры запросов pg в message не кладёт, а SyntaxError
      // расшифровки отсекает safeError. reason 'failed' — у кабинета и
      // мини-приложения на него свой общий текст.
      this.logger.warn(`keys ${row.id} упал между claim и исходом: ${safeError(e)}`);
      const message = 'Не получилось — попробуйте ещё раз позже';
      await this.actions.release(row.id, { error: message, reason: 'failed' });
      return { ok: false, reason: 'failed', message };
    }
  }

  private async submit(row: ActionRow, i: { userId: string; set: unknown; remove: unknown }): Promise<{ ok: true; queued: true } | KeysFail> {
    // reason — в result ВСЕГДА: по нему кабинет и мини-приложение переводят
    // текст на язык человека (products.action.keys.errors.<reason>); русский
    // error — запасной показ. field — `!== undefined`, а не истинность: у
    // ключа с пустым именем отказ формы приходит с field ''.
    const fix = async (message: string, reason: string, field?: string): Promise<KeysFail> => {
      await this.actions.release(row.id, field !== undefined ? { error: message, reason, field } : { error: message, reason });
      return { ok: false, reason, message };
    };
    const fail = async (message: string, reason: string): Promise<KeysFail> => {
      await this.actions.finish(row.id, 'failed', { error: message, reason });
      return { ok: false, reason, message };
    };

    const r = await this.pg.query(
      `SELECT id, kind, status, block_reason, secrets_encrypted, tg_bot_id FROM products
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [row.product_id, i.userId],
    );
    const p = r.rows[0];
    if (!p) return fail('Продукт удалён — ключи не менялись', 'gone');
    const refusal = statusRefusal(p);
    if (refusal) return fail(refusal.message, refusal.reason);

    // --- Форма тела. Значения — только в set, и только строками. ---
    const set: Record<string, string> = {};
    if (i.set !== undefined && i.set !== null) {
      if (typeof i.set !== 'object' || Array.isArray(i.set)) return fix('Ключи пришли не в той форме — обновите карточку', 'bad_shape');
      for (const [k, v] of Object.entries(i.set as Record<string, unknown>)) {
        if (typeof v !== 'string') return fix(`секрет ${k}: значение должно быть непустой строкой`, 'bad_input', k);
        // Object.defineProperty, а не присваивание: `__proto__` — годное имя
        // переменной (заведение его принимает), а `obj['__proto__'] = …`
        // своего ключа не создаёт — ключ молча пропал бы из набора.
        Object.defineProperty(set, k, { value: k === 'BOT_TOKEN' ? v.trim() : v, enumerable: true, writable: true, configurable: true });
      }
    }
    if (i.remove !== undefined && i.remove !== null && (!Array.isArray(i.remove) || i.remove.some((n) => typeof n !== 'string'))) {
      return fix('Список удаляемых ключей не в той форме — обновите карточку', 'bad_shape');
    }
    const remove = [...new Set((i.remove as string[] | undefined) ?? [])];
    if (!Object.keys(set).length && !remove.length) return fix('Ничего не изменено: замените, уберите или добавьте ключ', 'nothing');
    const both = remove.find((n) => has(set, n));
    if (both !== undefined) return fix(`Ключ ${both} и заменён, и убран — оставьте что-то одно`, 'bad_input', both);
    if (p.kind === 'bot' && remove.includes('BOT_TOKEN')) return fix('Токен бота убрать нельзя — его можно только заменить', 'bot_token', 'BOT_TOKEN');

    // --- Занятость: правка и задание машины. ---
    const busy = await this.pg.query(
      `SELECT (SELECT count(*) FROM product_turns WHERE product_id = $1 AND status IN ('queued','running'))::int AS turns,
              (SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND status IN ('queued','running'))::int AS jobs`,
      [p.id],
    );
    if (busy.rows[0]?.turns > 0) return fix('Сейчас идёт правка продукта — отправьте карточку, когда она закончится', 'busy_turn');
    if (busy.rows[0]?.jobs > 0) return fix('Машина продукта сейчас занята — отправьте карточку через минуту', 'busy');

    // --- Новый набор целиком и проверка теми же правилами, что заведение. ---
    // Нечитаемая коробка бросает — её ловит complete() (карточка снова ждёт).
    const old = ownerKeys(p.secrets_encrypted ? this.secrets.decrypt(p.secrets_encrypted, p.id) : {});
    const reservedDrop = remove.find((n) => isReservedSecretName(n));
    if (reservedDrop !== undefined) {
      return fix(`Ключ ${reservedDrop} — переменная платформы: карточкой его не убрать`, 'bad_input', reservedDrop);
    }
    const missing = remove.find((n) => !has(old, n));
    if (missing !== undefined) return fix(`Ключа ${missing} у продукта нет`, 'bad_input', missing);
    // Object.fromEntries, а не присваивание: имя `__proto__` форму переменной
    // проходит (как и у заведения), а `obj['__proto__'] = …` своего ключа не
    // создаёт.
    const merged: Record<string, string> = Object.fromEntries([
      ...Object.entries(old).filter(([k]) => !remove.includes(k) && !has(set, k)),
      ...Object.entries(set),
    ]);
    const problem = secretsProblem(merged);
    if (problem) return fix(problem.message, problem.field !== undefined ? 'bad_input' : 'too_many', problem.field);
    if (p.kind === 'bot' && !merged.BOT_TOKEN) return fix('У бота должен быть BOT_TOKEN', 'bot_token', 'BOT_TOKEN');

    // --- Новый токен бота — в Telegram, до записи чего-либо. ---
    let tgBotId: number | undefined;
    if (p.kind === 'bot' && set.BOT_TOKEN !== undefined && set.BOT_TOKEN !== old.BOT_TOKEN) {
      const check = await this.checkBot(set.BOT_TOKEN);
      // `=== false`, а не `!check.ok`: strictNullChecks выключен (см. «Общее»).
      if (check.ok === false) {
        return check.reason === 'unreachable'
          ? fix('Не удалось проверить токен в Telegram — попробуйте ещё раз через минуту', 'token_unchecked', 'BOT_TOKEN')
          : fix('Telegram не принял токен бота — скопируйте его целиком из @BotFather', 'bad_token', 'BOT_TOKEN');
      }
      if (Number(p.tg_bot_id) !== check.id) {
        // Окончательно бота закрепляет частичный UNIQUE products_tg_bot_live
        // в отчёте агента (лучшим усилием, см. completeRekeyJob); здесь —
        // чтобы не пересоздавать контейнер ради заведомо занятого бота.
        const taken = await this.pg.query(
          `SELECT 1 FROM products WHERE tg_bot_id = $1 AND archived_at IS NULL AND id <> $2 LIMIT 1`,
          [check.id, p.id],
        );
        if (taken.rows.length) return fix('Этот бот уже работает в другом продукте — создайте в @BotFather нового бота', 'bot_in_use', 'BOT_TOKEN');
        tgBotId = check.id;
      }
    }

    // --- Задание и коробка — одним оператором; коробка — только при задании. ---
    // Имена полей читает ProvisioningService: removedNames — в dropNames
    // выдачи агенту, newKeyNames — в итог карточки (и [] → NULL в продукте),
    // tgBotId — в products.tg_bot_id отчётом об успехе.
    const patch = {
      newKeyNames: Object.keys(merged).sort(),
      removedNames: Object.keys(old).filter((n) => !has(merged, n)).sort(),
      changedNames: Object.keys(set).filter((k) => old[k] !== set[k]).sort(),
      ...(tgBotId !== undefined ? { tgBotId } : {}),
    };
    const box = this.secrets.encrypt(merged, p.id);
    let q: any;
    try {
      q = await this.pg.query(
        `WITH ins AS (
            INSERT INTO product_provision_jobs (product_id, kind, status, action_id)
            SELECT pr.id, 'rekey', 'queued', a.id
              FROM product_actions a JOIN products pr ON pr.id = a.product_id
             WHERE a.id = $1 AND a.status = 'working' AND a.kind = 'keys'
               AND pr.archived_at IS NULL AND pr.status IN ('running','degraded') AND pr.block_reason IS NULL
               -- Правка могла встать между проверкой занятости и этой записью:
               -- выдача rekey её всё равно дождалась бы, но ставить смену
               -- поверх живой правки незачем — то же «занято», что выше.
               AND NOT EXISTS (SELECT 1 FROM product_turns t
                                WHERE t.product_id = pr.id AND t.status IN ('queued','running'))
            RETURNING action_id
         ), upd AS (
            UPDATE product_actions a SET secrets_box = $2, payload = a.payload || $3::jsonb
              FROM ins WHERE a.id = ins.action_id
            RETURNING a.id
         )
         SELECT (SELECT count(*) FROM ins)::int AS queued`,
        [row.id, box, JSON.stringify(patch)],
      );
    } catch (e: any) {
      // Задание другого вида встало между проверкой занятости и записью:
      // одно активное задание на продукт держит этот индекс.
      if (e?.code === '23505' && e?.constraint === 'product_provision_jobs_one_active') {
        return fix('Машина продукта сейчас занята — отправьте карточку через минуту', 'busy');
      }
      throw e;
    }
    if (!q.rows[0]?.queued) return fail('Продукт сменил состояние — ключи не меняются, попросите ассистента ещё раз', 'state_changed');
    return { ok: true, queued: true };
  }
}
