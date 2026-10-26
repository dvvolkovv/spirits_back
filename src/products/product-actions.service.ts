import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

export type ActionKind = 'create_site' | 'create_bot' | 'keys' | 'delete' | 'restore' | 'revert' | 'purge';
export type ActionStatus = 'pending' | 'working' | 'done' | 'failed' | 'expired' | 'cancelled';
export type ActionChannel = 'web' | 'telegram' | 'system';
export type ConfirmedVia = 'chat' | 'telegram' | 'tma' | 'cabinet';
/** Действия, которые ждут человека. Остальные пишутся в журнал сразу итогом. */
export type CardKind = 'create_bot' | 'delete' | 'keys';

export const ACTION_TTL_MINUTES = 30;
/**
 * Срок возврата удалённого продукта. Единственный источник: сервис
 * жизненного цикла берёт его отсюда (обратный импорт дал бы кольцо).
 */
export const DELETE_GRACE_DAYS = 30;

/**
 * Итог несостоявшейся смены ключей — для карточки и ассистента. Сырая причина
 * агента (stderr docker, срок, откат) остаётся в product_provision_jobs.error:
 * человеку она ничего не скажет, а значение ключа там в теории может
 * оказаться (агент маскирует, но журнал карточки читается шире).
 */
export const REKEY_FAILED_SAY =
  'Ключи не применены — продукт работает со старыми ключами. Попробуйте ещё раз через несколько минут; не выйдет — напишите в поддержку.';

/**
 * Смена ключей, исход которой на машине НЕИЗВЕСТЕН: откат не удался, агент
 * бросил смену по сроку, задание сняли у агента в руках. Продукт может не
 * отвечать — честно так и сказать; на сервере это logger.error со слагом.
 */
export const REKEY_UNKNOWN_SAY =
  'Смена ключей прервалась на машине продукта, и он может не отвечать. Если продукт молчит дольше нескольких минут — напишите в поддержку.';

/** Смена ключей снята удалением продукта до того, как агент её взял. */
export const REKEY_GONE_SAY = 'Продукт удалён — ключи не менялись.';

/** Смена ключей снята блокировкой администратора до того, как агент её взял. */
export const REKEY_BLOCKED_SAY = 'Продукт остановлен администратором — ключи не менялись.';

/** Итог несостоявшегося стирания в журнале: обход повторит его сам. */
export const PURGE_FAILED_SAY = 'Стирание не удалось — повторится автоматически';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActionRow {
  id: string;
  user_id: string;
  product_id: string | null;
  kind: ActionKind;
  status: ActionStatus;
  channel: ActionChannel;
  confirmed_via: ConfirmedVia | null;
  payload: any;
  result: any;
  created_at: Date;
  expires_at: Date | null;
  resolved_at: Date | null;
  tg_chat_id: string | null;
  tg_message_id: string | null;
  product_name?: string | null;
  purge_after?: Date | null;
}

export interface ActionView {
  id: string;
  kind: ActionKind;
  status: ActionStatus;
  productId: string | null;
  productName: string | null;
  keyNames: string[];
  expiresAt: string | null;
  restoreUntil: string | null;
  result: Record<string, unknown> | null;
}

const COLUMNS = `a.id, a.user_id, a.product_id, a.kind, a.status, a.channel, a.confirmed_via, a.payload,
                 a.result, a.created_at, a.expires_at, a.resolved_at, a.tg_chat_id, a.tg_message_id,
                 p.name AS product_name, p.purge_after`;

/**
 * Вид для карточки и ассистента. Значений ключей в нём нет по построению: их
 * нет ни в payload, ни в result — в строку пишутся только имена.
 */
export function toView(row: ActionRow, now: Date = new Date()): ActionView {
  const expired = row.status === 'pending' && row.expires_at !== null && new Date(row.expires_at) <= now;
  let restoreUntil: string | null = null;
  if (row.kind === 'delete') {
    restoreUntil = row.status === 'done'
      ? (typeof row.result?.restoreUntil === 'string' ? row.result.restoreUntil : null)
      : new Date(now.getTime() + DELETE_GRACE_DAYS * 86_400_000).toISOString();
  }
  return {
    id: row.id,
    kind: row.kind,
    status: expired ? 'expired' : row.status,
    productId: row.product_id,
    productName: row.product_name ?? (typeof row.payload?.name === 'string' ? row.payload.name : null),
    keyNames: Array.isArray(row.payload?.keyNames) ? row.payload.keyNames : [],
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    restoreUntil,
    result: row.result ?? null,
  };
}

/**
 * Ожидающие действия (карточки) и журнал жизненного цикла продуктов.
 * Каждый переход — один оператор со своими предусловиями: «двойное нажатие —
 * один раз» держит база, а не проверка в коде между двумя запросами.
 */
@Injectable()
export class ProductActionsService {
  constructor(private readonly pg: PgService) {}

  async open(i: {
    userId: string;
    productId: string | null;
    kind: CardKind;
    channel: ActionChannel;
    turn: string | null;
    payload: Record<string, unknown>;
  }): Promise<{ id: string; expiresAt: string }> {
    const r = await this.pg.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, turn_nonce, payload, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6::jsonb, now() + make_interval(mins => $7))
       RETURNING id, expires_at`,
      [i.userId, i.productId, i.kind, i.channel, i.turn, JSON.stringify(i.payload), ACTION_TTL_MINUTES],
    );
    return { id: r.rows[0].id, expiresAt: new Date(r.rows[0].expires_at).toISOString() };
  }

  /** Строка журнала для действия без карточки. К ходу не прикрепляется. */
  async record(i: {
    userId: string;
    productId: string | null;
    kind: ActionKind;
    channel: ActionChannel;
    status: 'done' | 'failed';
    payload?: Record<string, unknown>;
    result?: Record<string, unknown>;
  }): Promise<string> {
    const r = await this.pg.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, result, attached_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now(), now())
       RETURNING id`,
      [i.userId, i.productId, i.kind, i.status, i.channel, JSON.stringify(i.payload ?? {}), JSON.stringify(i.result ?? {})],
    );
    return r.rows[0].id;
  }

  /**
   * Карточки, заведённые ходом: по метке из токена ИЛИ (запасной путь —
   * релей принёс токен прошлого хода) заведённые за время хода. Каждая
   * отдаётся один раз: attached_at ставится тем же оператором.
   *
   * channel, если задан, сужает запасной путь по окну хода до своего канала:
   * без него веб-ход мог бы прихватить карточку, заведённую в это же время
   * ботом Telegram, и наоборот. Две параллельные хода ОДНОГО пользователя в
   * ОДНОМ и том же канале всё ещё могут перехватить карточку друг друга —
   * это принято: список «ждёт подтверждения» в кабинете — страховка на
   * этот случай, карточка оттуда никуда не пропадает.
   */
  async takeForTurn(
    userId: string,
    turn: string | null,
    since: Date,
    channel?: ActionChannel,
  ): Promise<Array<{ id: string; kind: CardKind; payload: any }>> {
    const r = await this.pg.query(
      `UPDATE product_actions SET attached_at = now()
        WHERE user_id = $1 AND status = 'pending' AND attached_at IS NULL
          AND (turn_nonce = $2 OR created_at >= $3)
          AND ($4::text IS NULL OR channel = $4)
       RETURNING id, kind, payload, created_at`,
      [userId, turn, since, channel ?? null],
    );
    return [...r.rows]
      .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map((x: any) => ({ id: x.id, kind: x.kind, payload: x.payload }));
  }

  async get(userId: string, id: string): Promise<ActionRow | null> {
    if (!UUID_RE.test(String(id))) return null;
    const r = await this.pg.query(
      `SELECT ${COLUMNS} FROM product_actions a LEFT JOIN products p ON p.id = a.product_id
        WHERE a.id = $1 AND a.user_id = $2`,
      [id, userId],
    );
    return r.rows[0] ?? null;
  }

  /** Без владельца — для кнопок Telegram, где владельца проверяет вызывающий. */
  async getById(id: string): Promise<ActionRow | null> {
    if (!UUID_RE.test(String(id))) return null;
    const r = await this.pg.query(
      `SELECT ${COLUMNS} FROM product_actions a LEFT JOIN products p ON p.id = a.product_id WHERE a.id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async listPending(userId: string): Promise<ActionRow[]> {
    const r = await this.pg.query(
      `SELECT ${COLUMNS} FROM product_actions a LEFT JOIN products p ON p.id = a.product_id
        WHERE a.user_id = $1 AND a.status = 'pending' AND a.expires_at > now()
        ORDER BY a.created_at`,
      [userId],
    );
    return r.rows;
  }

  /** Взять в работу. Повторное нажатие, чужой и просроченный получают null. */
  async claim(userId: string, id: string, via: ConfirmedVia): Promise<ActionRow | null> {
    if (!UUID_RE.test(String(id))) return null;
    // Явный список своих колонок, а не RETURNING * и не join: secrets_box —
    // шифротекст ключей (очередь 2), ему сюда попадать нельзя ни при каких
    // раскладах, а join с products тут и не нужен — имя продукта в payload.
    const r = await this.pg.query(
      `UPDATE product_actions SET status = 'working', confirmed_via = $3
        WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > now()
       RETURNING id, user_id, product_id, kind, status, channel, confirmed_via, payload, result,
                 created_at, expires_at, resolved_at, tg_chat_id, tg_message_id`,
      [id, userId, via],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Вернуть в ожидание с ошибкой — то, что человек поправит в той же карточке.
   * Без владельца: сюда доходят только после claim() — он уже проверил, что
   * действие принадлежит вызывающему.
   */
  async release(id: string, result: Record<string, unknown>): Promise<void> {
    if (!UUID_RE.test(String(id))) return;
    await this.pg.query(
      `UPDATE product_actions SET status = 'pending', confirmed_via = NULL, result = $2::jsonb
        WHERE id = $1 AND status = 'working'`,
      [id, JSON.stringify(result)],
    );
  }

  /**
   * Без владельца: сюда доходят только после claim() — он уже проверил, что
   * действие принадлежит вызывающему.
   */
  async finish(id: string, status: 'done' | 'failed', result: Record<string, unknown>, productId?: string): Promise<void> {
    if (!UUID_RE.test(String(id))) return;
    await this.pg.query(
      `UPDATE product_actions
          SET status = $2, result = $3::jsonb, resolved_at = now(), product_id = COALESCE($4::uuid, product_id)
        WHERE id = $1 AND status = 'working'`,
      [id, status, JSON.stringify(result), productId || null],
    );
  }

  /**
   * working-карточки, чей процесс умер между claim и finish/release (обрыв
   * с базой, падение процесса) — то, что completeDelete/completeCreateBot
   * сами чинят release-ом на известных отказах не ловит: их catch просто не
   * выполнился. claim и cancel требуют status='pending', поэтому без этой
   * подметки такая карточка осталась бы в working навечно.
   *
   * expires_at у working НЕ продлевается claim-ом (он остаётся таким же,
   * каким был у pending) — поэтому срок в прошлом у working-строки надёжно
   * отличает мертвеца от долгой, но живой операции: сама работа (проверка
   * токена, один SQL) занимает секунды, а не минуты. Запас 10 минут — чтобы
   * не подмести карточку, которую в эту секунду как раз обрабатывает живой
   * процесс на грани истечения срока.
   */
  async sweepStuck(): Promise<number> {
    const r = await this.pg.query(
      `UPDATE product_actions
          SET status = 'failed',
              result = jsonb_build_object('error', 'Действие прервалось — попросите ассистента повторить'),
              resolved_at = now()
        WHERE status = 'working' AND expires_at < now() - interval '10 minutes'
       RETURNING id`,
    );
    return r.rows.length;
  }

  async cancel(userId: string, id: string): Promise<boolean> {
    if (!UUID_RE.test(String(id))) return false;
    const r = await this.pg.query(
      `UPDATE product_actions SET status = 'cancelled', resolved_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING id`,
      [id, userId],
    );
    return r.rows.length > 0;
  }

  /**
   * Без владельца: сюда доходят только после claim() — он уже проверил, что
   * действие принадлежит вызывающему.
   */
  async setTelegramMessage(id: string, chatId: number, messageId: number): Promise<void> {
    if (!UUID_RE.test(String(id))) return;
    await this.pg.query(
      `UPDATE product_actions SET tg_chat_id = $2, tg_message_id = $3 WHERE id = $1`,
      [id, chatId, messageId],
    );
  }
}
