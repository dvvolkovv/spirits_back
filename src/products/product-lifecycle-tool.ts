import { Injectable, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { DELETE_GRACE_DAYS, ProductLifecycleService } from './product-lifecycle.service';
import { ActionStatus, ProductActionsService, toView } from './product-actions.service';
import type { ProductMatch } from './product-tool.service';
import type { ProductToolChannel } from './product-tool.token';
import { RENT_TOKENS } from './rent.service';
import { ProductKeysService } from './product-keys.service';
import { maskedSecretsSay } from './prompt-secrets';

/** «50 000» — как в остальных текстах для людей. Та же форма — для любого
 *  числа токенов (баланс в тексте «не хватает», п.2), не только для RENT_TOKENS. */
const tokenText = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const RENT_TOKEN_TEXT = tokenText(RENT_TOKENS);

export interface DeletedProduct {
  id: string;
  name: string;
  slug: string;
  kind: string;
  purge_after: string;
}

const ACTION_SAY: Record<ActionStatus, string> = {
  pending: 'Пользователь ещё не подтвердил карточку.',
  working: 'Действие выполняется — посмотри через минуту.',
  done: 'Готово: действие выполнено.',
  failed: 'Не получилось — причина в action.result.error. Скажи о ней пользователю своими словами.',
  expired: 'Срок карточки вышел. Если пользователь всё ещё хочет, вызови действие заново.',
  cancelled: 'Пользователь отменил действие.',
};

/** Статусы, которые для ассистента НЕ успех — остальные (включая pending/working) ok:true,
 * как и у describeTurn с queued/running: карточка только что заведена, и это не отказ. */
const ACTION_NOT_OK: ReadonlySet<ActionStatus> = new Set(['failed', 'expired', 'cancelled']);

function restoreDate(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(iso));
}

/**
 * Новые действия manage_product: create, delete, restore, revert и статус
 * карточки. Отдельным классом: product-tool.service.ts и так за 650 строк.
 * Решения — в ProductLifecycleService, здесь только выбор и пересказ.
 */
@Injectable()
export class ProductLifecycleTool {
  constructor(
    private readonly pg: PgService,
    private readonly lifecycle: ProductLifecycleService,
    private readonly actions: ProductActionsService,
    // Смена ключей (очередь 2). @Optional и последним — по той же причине,
    // что lifecycleTool в ProductToolService.
    @Optional() private readonly keysSvc?: ProductKeysService,
  ) {}

  async listDeleted(userId: string): Promise<DeletedProduct[]> {
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, purge_after FROM products
        WHERE user_id = $1 AND archived_at IS NOT NULL AND purged_at IS NULL AND purge_after > now()
        ORDER BY archived_at DESC`,
      [userId],
    );
    return r.rows.map((x: any) => ({ ...x, purge_after: new Date(x.purge_after).toISOString() }));
  }

  private async resolveDeleted(userId: string, query: string): Promise<DeletedProduct[]> {
    const raw = String(query ?? '').trim().toLowerCase();
    if (!raw) return [];
    const like = `%${raw.replace(/([\\%_])/g, '\\$1')}%`;
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, purge_after FROM products
        WHERE user_id = $1 AND archived_at IS NOT NULL AND purged_at IS NULL AND purge_after > now()
          AND (id::text = $2 OR lower(slug) = $2 OR lower(name) LIKE $3)
        ORDER BY archived_at DESC`,
      [userId, raw, like],
    );
    return r.rows.map((x: any) => ({ ...x, purge_after: new Date(x.purge_after).toISOString() }));
  }

  /** Удалённые, которые уже не вернуть: стёрты (purged) или срок возврата вышел, а машина ещё не стёрла. */
  private async resolveGone(userId: string, query: string): Promise<Array<DeletedProduct & { purged: boolean }>> {
    const raw = String(query ?? '').trim().toLowerCase();
    if (!raw) return [];
    const like = `%${raw.replace(/([\\%_])/g, '\\$1')}%`;
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, purge_after, purged_at FROM products
        WHERE user_id = $1 AND archived_at IS NOT NULL AND (purged_at IS NOT NULL OR purge_after <= now())
          AND (id::text = $2 OR lower(slug) = $2 OR lower(name) LIKE $3)
        ORDER BY archived_at DESC LIMIT 1`,
      [userId, raw, like],
    );
    return r.rows.map((x: any) => ({
      id: x.id, name: x.name, slug: x.slug, kind: x.kind,
      purge_after: x.purge_after ? new Date(x.purge_after).toISOString() : null,
      purged: x.purged_at !== null && x.purged_at !== undefined,
    }));
  }

  // Без метки хода (загрузка файла, токен старого вида) сервер карточку к
  // ответу не прикрепит — она есть только в кабинете, и say говорит это
  // прямо: иначе модель пообещала бы карточку «под ответом», которой не будет.
  async create(userId: string, input: any, channel: ProductToolChannel, turn: string | null) {
    const kind = String(input?.kind ?? '').trim();
    if (kind === 'site') {
      const r = await this.lifecycle.createSite({ userId, name: input?.name, prompt: input?.prompt, channel });
      if (r.ok === false) return { ok: false, reason: r.reason, say: r.message };
      return {
        ok: true,
        created: { kind: 'site', productId: r.productId, slug: r.slug, domain: r.domain, freeMonth: r.freeMonth },
        ...(r.secretsMasked ? { secretsMasked: r.secretsMasked } : {}),
        // domain бывает null — заведение само отработало (сайт СУЩЕСТВУЕТ),
        // а чтение домена именно этим запросом сорвалось (см. createSite):
        // «https://null» выглядело бы настоящим адресом, а не как отказ
        // одного необязательного шага.
        say: (r.domain
          ? `Сайт создан и заводится: через минуту-две откроется по адресу https://${r.domain}.`
          : 'Сайт создан и заводится: адрес появится в списке продуктов через минуту-две.') +
          // `=== true`, а не приведение к истинности — та же осторожность, что
          // в ProvisioningService.create: сломанная выдача не должна молча
          // читаться как «бесплатно».
          (r.freeMonth === true
            ? ' Первый месяц аренды бесплатный.'
            : ` Аренда ${RENT_TOKEN_TEXT} токенов спишется при запуске; не хватит баланса — продукт уснёт до пополнения.`) +
          // «Поставлена» — только если setFirstPrompt РЕАЛЬНО сработал
          // (createSite вернул firstPromptSet): prompt мог быть дан, но его
          // постановка упасть — ассистент не должен обещать то, чего не было.
          (r.firstPromptSet
            ? ' Первая правка по описанию поставлена и начнётся, когда сайт поднимется; её исход — действием status по имени продукта.'
            : ' Дальше — правки действием edit.') +
          (r.secretsMasked ? ` ${maskedSecretsSay(r.secretsMasked)}` : ''),
      };
    }
    if (kind === 'bot') {
      const r = await this.lifecycle.openCreateBot({ userId, name: input?.name, prompt: input?.prompt, channel, turn });
      if (r.ok === false) return { ok: false, reason: r.reason, say: r.message };
      return {
        ok: true,
        pending: { actionId: r.actionId, kind: 'create_bot', expiresAt: r.expiresAt },
        ...(r.secretsMasked ? { secretsMasked: r.secretsMasked } : {}),
        say: (!turn
          ? 'Защищённая карточка ждёт пользователя в кабинете (Студия → Продукты): там он'
          : channel === 'telegram'
            ? 'Ниже придёт сообщение с кнопкой: пользователь откроет защищённую форму'
            : 'Под твоим ответом появится защищённая карточка: пользователь')
          + ' введёт в неё токен бота от @BotFather и ключи сервисов. Ключи в переписке не проси. ' +
          'Бот создастся, когда он отправит карточку; итог — действием status с этим actionId.' +
          (r.secretsMasked ? ` ${maskedSecretsSay(r.secretsMasked)}` : ''),
      };
    }
    return { ok: false, reason: 'bad_kind', say: 'Укажи kind: "site" (сайт) или "bot" (телеграм-бот) и name.' };
  }

  async delete(userId: string, product: ProductMatch, channel: ProductToolChannel, turn: string | null) {
    const r = await this.lifecycle.openDelete({ userId, productId: product.id, channel, turn });
    if (r.ok === false) return { ok: false, reason: r.reason, product, say: r.message };
    // Условно (задача «Отступления очереди 1», п.3): фраза про невозвратный
    // срок — только если он ещё реально идёт (бесплатный месяц или уже
    // оплаченный). У продукта, которому и так уже пора платить, эта фраза
    // была бы пустой угрозой про несуществующий остаток.
    //
    // M5 (ревью): «платный с первого дня, до собственного первого перевода
    // в running» здесь НЕ бывает — openDelete отказывает удалению продукта
    // со status='provisioning' (см. там), то есть удалить можно только
    // продукт, который этот переход уже прошёл. Реальные случаи с
    // paid_until в прошлом на этом месте — спящий за неуплату (период
    // истёк, пробуждение ещё не случилось) и failed (не завёлся вовсе,
    // аренда на него никогда и не начислялась).
    const paidUntil = new Date(r.paidUntil);
    const periodLeft = paidUntil.getTime() > Date.now();
    return {
      ok: true,
      pending: { actionId: r.actionId, kind: 'delete', expiresAt: r.expiresAt },
      product,
      say: (!turn
        ? 'Карточка с кнопкой «Удалить» ждёт пользователя в кабинете (Студия → Продукты).'
        : channel === 'telegram' ? 'Ниже придёт сообщение с кнопкой «Удалить».' : 'Под твоим ответом появится карточка с кнопкой «Удалить».') +
        ` Продукт удалится, только когда пользователь нажмёт её. Вернуть его можно будет ${DELETE_GRACE_DAYS} дней` +
        (periodLeft ? `, оставшийся срок до ${restoreDate(r.paidUntil)} не возвращается. ` : '. ') +
        'Не говори «удалил», пока status не вернёт done.',
    };
  }

  async keys(userId: string, product: ProductMatch, channel: ProductToolChannel, turn: string | null) {
    if (!this.keysSvc) return { ok: false, reason: 'unavailable', product, say: 'Смена ключей сейчас недоступна.' };
    const r = await this.keysSvc.open({ userId, productId: product.id, channel, turn });
    if (r.ok === false) return { ok: false, reason: r.reason, product, say: r.message };
    return {
      ok: true,
      pending: { actionId: r.actionId, kind: 'keys', expiresAt: r.expiresAt },
      product,
      keyNames: r.keyNames,
      say: (!turn
        ? 'Защищённая карточка ключей ждёт пользователя в кабинете (Студия → Продукты).'
        : channel === 'telegram'
          ? 'Ниже придёт сообщение с кнопкой: пользователь откроет защищённую форму ключей.'
          : 'Под твоим ответом появится защищённая карточка ключей.') +
        ` В ней имена текущих ключей (${r.keyNames.length ? r.keyNames.join(', ') : 'ключей пока нет'}): их можно заменить, убрать или добавить новые. ` +
        'Значения вводит только пользователь — в переписке ключи не проси. Продукт перезапустится с новыми ключами; ' +
        'не говори «ключи обновлены», пока status с этим actionId не вернёт done.',
    };
  }

  async restore(userId: string, input: any, channel: ProductToolChannel) {
    const matches = await this.resolveDeleted(userId, String(input?.product ?? ''));
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous', matches, say: 'Под описание подходит несколько удалённых продуктов. Спроси, какой вернуть.' };
    }
    if (!matches.length) {
      const gone = await this.resolveGone(userId, String(input?.product ?? ''));
      if (gone.length) {
        const g = gone[0];
        // «Уже стёрт» — только когда машина правда стёрла (purged_at). Срок
        // вышел, а стирание ещё в очереди — честное «стирается».
        return {
          ok: false, reason: g.purged ? 'purged' : 'expiring', product: g,
          say: g.purged
            ? `«${g.name}» уже стёрт: срок возврата (${DELETE_GRACE_DAYS} дней) вышел, вернуть его нельзя. Можно завести новый продукт.`
            : `Срок возврата «${g.name}» (${DELETE_GRACE_DAYS} дней) вышел — продукт стирается, вернуть его нельзя. Можно завести новый продукт.`,
        };
      }
      const deleted = await this.listDeleted(userId);
      return {
        ok: false, reason: 'not_found', deleted,
        say: deleted.length ? 'Такого удалённого продукта нет. Вот какие можно вернуть.' : 'Удалённых продуктов, которые можно вернуть, нет.',
      };
    }
    const product = matches[0];
    const r = await this.lifecycle.restore({ userId, productId: product.id, channel });
    if (r.ok === false) {
      // Гонка (ревью 15b): resolveDeleted прочитал продукт ДО дедлайна
      // возврата, restore() проверил его ПОСЛЕ — срок вышел между двумя
      // запросами. Тот же reason и текст, что resolveGone отдаёт на
      // «стирается» (выше): описание действия обещает модели только
      // purged/expiring, а не сырой reason="expired" сервиса.
      if (r.reason === 'expired') {
        return {
          ok: false, reason: 'expiring', product,
          say: `Срок возврата «${product.name}» (${DELETE_GRACE_DAYS} дней) вышел — продукт стирается, вернуть его нельзя. Можно завести новый продукт.`,
        };
      }
      return { ok: false, reason: r.reason, product, say: r.message };
    }
    // I1 (ревью): affordable — ТЕМ ЖЕ способом, что и внутри restore()
    // (`balance >= RENT_TOKENS`), но здесь своя переменная: ответ тула не
    // отдаёт её прямо, только balance, и ветка M7 ниже (waking=false, но
    // денег хватает) нужна именно ей, а не r.waking.
    const affordable = r.balance >= RENT_TOKENS;
    return {
      ok: true,
      restored: { productId: product.id, status: r.status, waking: r.waking, balance: r.balance },
      product,
      // 'failed' — продукт вернулся таким же сломанным, каким был до
      // удаления (M3): это не вопрос денег, пополнение баланса тут не
      // поможет и предлагать его не нужно — нужен разбор причины поломки.
      //
      // ВЕТКА waking ТЕПЕРЬ ПОКРЫВАЕТ ДВА РАЗНЫХ СЛУЧАЯ (п.2 «Отступления
      // очереди 1»): оплаченный период ещё идёт (r.paid) ИЛИ его нет, но
      // баланс покрывает аренду — ProductLifecycleService.restore будит сам
      // в обоих, и само пробуждение для пользователя не отличить. НО ТЕКСТ
      // ОБЯЗАН различать (I1, ревью): у paid-продукта аренда уже оплачена —
      // chargeOnStart её не спишет (его предусловие `paid_until <= now()` не
      // совпадёт), и говорить «спишется при запуске» было бы неправдой.
      //
      // M7: ветка «не хватает» различается по AFFORDABLE, не по waking —
      // waking=false при деньгах, которых хватает, означало бы, что
      // restore() не поставил пробуждение (защитная, по сути недостижимая
      // ветка — см. комментарий в ProductLifecycleService.restore), и текст
      // «не хватило токенов» в этом случае был бы неправдой о продукте,
      // которому хватает.
      say: r.status === 'blocked'
        ? 'Продукт возвращён, но он остановлен администратором: правки не принимаются, пополнение не поможет.'
        : r.status === 'failed'
          ? 'Продукт возвращён, но он не работал ещё до удаления (поломка) — пополнение баланса тут не поможет, нужно разобраться в причине.'
          : r.waking
            ? (r.paid
                ? `Вернул. Просыпается — через минуту-две заработает; оплаченный срок до ${restoreDate(r.paidUntil)} продолжается.`
                : `Вернул. Просыпается — через минуту-две заработает; аренда ${RENT_TOKEN_TEXT} токенов спишется при запуске.`)
            : affordable
              ? `Вернул; проснётся в течение нескольких минут, аренда ${RENT_TOKEN_TEXT} токенов спишется при запуске.`
              : `Вернул, но он спит: на аренду нужно ${RENT_TOKEN_TEXT} токенов, на балансе ${tokenText(r.balance)} — после пополнения проснётся сам.`,
    };
  }

  /** Откат: { ok:true, turnId } — дальше исход ждёт ProductToolService; отказы очереди правок — броском. */
  revert(userId: string, product: ProductMatch, turnId: unknown, channel: ProductToolChannel) {
    return this.lifecycle.revert({ userId, productId: product.id, turnId: turnId ? String(turnId) : null, channel });
  }

  async actionStatus(userId: string, actionId: unknown) {
    const row = await this.actions.get(userId, String(actionId ?? '').trim());
    if (!row) return { ok: false, reason: 'not_found', say: 'Такого действия у пользователя нет.' };
    const action = toView(row);
    const fixable = action.status === 'pending' && typeof action.result?.error === 'string';
    const deleteDone = action.kind === 'delete' && action.status === 'done' && action.restoreUntil;
    // freeMonth узнаётся только здесь: при открытии карточки (openCreateBot)
    // продукта ещё нет, и до завершения (completeCreateBot) никто не знает,
    // попал ли он в бесплатный месяц — см. комментарий в completeCreateBot.
    const botDone = action.kind === 'create_bot' && action.status === 'done';
    const keysDone = action.kind === 'keys' && action.status === 'done';
    const keysWorking = action.kind === 'keys' && action.status === 'working';
    return {
      ok: !ACTION_NOT_OK.has(action.status),
      action,
      say: fixable
        ? `Пользователь отправил карточку, но её не приняли: ${action.result!.error}. Карточка ждёт исправления.`
        : deleteDone
          ? `Готово: продукт удалён, вернуть его можно до ${restoreDate(action.restoreUntil!)} — действием restore.`
          : botDone
            ? `Готово: бот создан.` +
              (action.result?.freeMonth === true
                ? ' Первый месяц аренды бесплатный.'
                : ` Аренда ${RENT_TOKEN_TEXT} токенов спишется при запуске; не хватит баланса — продукт уснёт до пополнения.`)
            : keysDone
              ? 'Готово: ключи обновлены, продукт перезапущен с ними.'
              : keysWorking
                ? 'Ключи применяются: продукт перезапускается — посмотри через минуту.'
                : ACTION_SAY[action.status],
    };
  }
}
