import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { DELETE_GRACE_DAYS, ProductLifecycleService } from './product-lifecycle.service';
import { ActionStatus, ProductActionsService, toView } from './product-actions.service';
import type { ProductMatch } from './product-tool.service';
import type { ProductToolChannel } from './product-tool.token';

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
        created: { kind: 'site', productId: r.productId, slug: r.slug, domain: r.domain },
        say: `Сайт создан и заводится: через минуту-две откроется по адресу https://${r.domain}.` +
          (String(input?.prompt ?? '').trim()
            ? ' Первая правка по описанию поставлена и начнётся, когда сайт поднимется; её исход — действием status по имени продукта.'
            : ' Дальше — правки действием edit.'),
      };
    }
    if (kind === 'bot') {
      const r = await this.lifecycle.openCreateBot({ userId, name: input?.name, prompt: input?.prompt, channel, turn });
      if (r.ok === false) return { ok: false, reason: r.reason, say: r.message };
      return {
        ok: true,
        pending: { actionId: r.actionId, kind: 'create_bot', expiresAt: r.expiresAt },
        say: (!turn
          ? 'Защищённая карточка ждёт пользователя в кабинете (Студия → Продукты): там он'
          : channel === 'telegram'
            ? 'Ниже придёт сообщение с кнопкой: пользователь откроет защищённую форму'
            : 'Под твоим ответом появится защищённая карточка: пользователь')
          + ' введёт в неё токен бота от @BotFather и ключи сервисов. Ключи в переписке не проси. ' +
          'Бот создастся, когда он отправит карточку; итог — действием status с этим actionId.',
      };
    }
    return { ok: false, reason: 'bad_kind', say: 'Укажи kind: "site" (сайт) или "bot" (телеграм-бот) и name.' };
  }

  async delete(userId: string, product: ProductMatch, channel: ProductToolChannel, turn: string | null) {
    const r = await this.lifecycle.openDelete({ userId, productId: product.id, channel, turn });
    if (r.ok === false) return { ok: false, reason: r.reason, product, say: r.message };
    return {
      ok: true,
      pending: { actionId: r.actionId, kind: 'delete', expiresAt: r.expiresAt },
      product,
      say: (!turn
        ? 'Карточка с кнопкой «Удалить» ждёт пользователя в кабинете (Студия → Продукты).'
        : channel === 'telegram' ? 'Ниже придёт сообщение с кнопкой «Удалить».' : 'Под твоим ответом появится карточка с кнопкой «Удалить».') +
        ` Продукт удалится, только когда пользователь нажмёт её. Вернуть его можно будет ${DELETE_GRACE_DAYS} дней, оплаченный период не возвращается. ` +
        'Не говори «удалил», пока status не вернёт done.',
    };
  }

  async restore(userId: string, input: any, channel: ProductToolChannel) {
    const matches = await this.resolveDeleted(userId, String(input?.product ?? ''));
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous', matches, say: 'Под описание подходит несколько удалённых продуктов. Спроси, какой вернуть.' };
    }
    if (!matches.length) {
      const deleted = await this.listDeleted(userId);
      return {
        ok: false, reason: 'not_found', deleted,
        say: deleted.length ? 'Такого удалённого продукта нет. Вот какие можно вернуть.' : 'Удалённых продуктов, которые можно вернуть, нет.',
      };
    }
    const product = matches[0];
    const r = await this.lifecycle.restore({ userId, productId: product.id, channel });
    if (r.ok === false) return { ok: false, reason: r.reason, product, say: r.message };
    return {
      ok: true,
      restored: { productId: product.id, status: r.status, waking: r.waking },
      product,
      // 'failed' — продукт вернулся таким же сломанным, каким был до
      // удаления (M3): это не вопрос денег, пополнение баланса тут не
      // поможет и предлагать его не нужно — нужен разбор причины поломки.
      say: r.status === 'blocked'
        ? 'Продукт возвращён, но он остановлен администратором: правки не принимаются, пополнение не поможет.'
        : r.status === 'failed'
          ? 'Продукт возвращён, но он не работал ещё до удаления (поломка) — пополнение баланса тут не поможет, нужно разобраться в причине.'
          : r.waking
            ? 'Продукт возвращён и просыпается — через минуту-две снова заработает.'
            : 'Продукт возвращён, но оплаченный период кончился: он проснётся, когда на балансе хватит токенов на месяц аренды. Предложи пополнить баланс.',
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
    return {
      ok: !ACTION_NOT_OK.has(action.status),
      action,
      say: fixable
        ? `Пользователь отправил карточку, но её не приняли: ${action.result!.error}. Карточка ждёт исправления.`
        : deleteDone
          ? `Готово: продукт удалён, вернуть его можно до ${restoreDate(action.restoreUntil!)} — действием restore.`
          : ACTION_SAY[action.status],
    };
  }
}
