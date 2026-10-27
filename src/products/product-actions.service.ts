import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { JOB_KILLED_BY_BLOCK } from './block.service';

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
 * Смена ключей, исход которой на машине НЕИЗВЕСТЕН или не лечится повтором:
 * откат не удался, агент бросил смену по сроку, задание сняли у агента в
 * руках, на машине остался контейнер прерванной смены, контейнер продукта не
 * запущен (признаки — REKEY_UNKNOWN_RE в provisioning.service.ts). Продукт
 * может не отвечать — честно так и сказать; на сервере это logger.error со
 * слагом.
 */
export const REKEY_UNKNOWN_SAY =
  'Смена ключей прервалась на машине продукта, и он может не отвечать. Если продукт молчит дольше нескольких минут — напишите в поддержку.';

/**
 * Что записывается в задание, снятое удалением продукта (completeDelete,
 * sleepDeletedTick в product-lifecycle.service.ts). Общая строка — а не два
 * свободных литерала там и третий здесь в sweepStuck — чтобы «снято
 * удалением» не разошлось при правке одного места и не осталось незамеченным
 * другим: sweepStuck сверяет error по этой строке, отличая REKEY_GONE_SAY от
 * REKEY_FAILED_SAY.
 */
export const JOB_KILLED_BY_DELETE = 'снято удалением';

/** Смена ключей снята удалением продукта до того, как агент её взял. */
export const REKEY_GONE_SAY = 'Продукт удалён — ключи не менялись.';

/** Смена ключей снята блокировкой администратора до того, как агент её взял. */
export const REKEY_BLOCKED_SAY = 'Продукт остановлен администратором — ключи не менялись.';

/**
 * Итог несостоявшегося стирания в журнале. Обход повторяет стирание сам, но
 * не бесконечно — после предела провалов подряд оно ждёт разбора руками
 * (product-purge.service), поэтому без безусловного «повторится».
 */
export const PURGE_FAILED_SAY =
  'Стирание не удалось; повторится автоматически, если не исчерпан предел попыток, иначе — ручной разбор';

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
  /** Форма продукта: карточка ключей не предлагает убрать BOT_TOKEN у бота. */
  productKind: 'site' | 'bot' | null;
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
    productKind: row.kind === 'create_bot'
      ? 'bot'
      : row.kind === 'create_site'
      ? 'site'
      : (row.payload?.productKind === 'site' || row.payload?.productKind === 'bot' ? row.payload.productKind : null),
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
   * действие принадлежит вызывающему. Коробка ключей стирается и здесь:
   * pending-карточка шифротекста не держит никогда — новый набор пишется
   * только вместе с заданием (ProductKeysService).
   *
   * Условие на отсутствие активного задания — страховка: карточка с заданием
   * rekey в очереди или в работе уже СОВЕРШАЕТСЯ на машине, и откат в pending
   * здесь потерял бы это из вида (а стирание коробки — новые ключи, которые
   * задание как раз применяет). По архитектуре задание ставится тем же
   * оператором, что отправляет карточку (ProductKeysService), поэтому путь
   * «есть активное задание → всё равно зовут release» не штатный — это
   * именно защита от будущей ошибки вызывающего, а не наблюдаемый сегодня
   * случай.
   *
   * payloadPatch — поля, которые дописываются в payload поверх прежних: так
   * карточка ключей узнаёт текущий набор имён, когда её список устарел (ключ
   * уже сняла другая карточка) — иначе после перезагрузки она снова покажет
   * снятый ключ, и человек ходил бы по кругу.
   */
  async release(id: string, result: Record<string, unknown>, payloadPatch?: Record<string, unknown>): Promise<void> {
    if (!UUID_RE.test(String(id))) return;
    await this.pg.query(
      `UPDATE product_actions SET status = 'pending', confirmed_via = NULL, result = $2::jsonb, secrets_box = NULL,
              payload = CASE WHEN $3::jsonb IS NULL THEN payload ELSE COALESCE(payload, '{}'::jsonb) || $3::jsonb END
        WHERE id = $1 AND status = 'working'
          -- $1, а не коррелированный id: сравнение со своим же id внутри
          -- подзапроса было бы неоднозначным — у product_provision_jobs
          -- тоже есть столбец id, и он перекрыл бы внешний (действие на
          -- единственную строку $1 — коррелировать нечем, она и так одна).
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = $1 AND j.status IN ('queued','running'))`,
      [id, JSON.stringify(result), payloadPatch ? JSON.stringify(payloadPatch) : null],
    );
  }

  /**
   * Без владельца: сюда доходят только после claim() — он уже проверил, что
   * действие принадлежит вызывающему. Любое закрытие стирает коробку ключей:
   * шифротекст живёт не дольше задания.
   */
  async finish(id: string, status: 'done' | 'failed', result: Record<string, unknown>, productId?: string): Promise<void> {
    if (!UUID_RE.test(String(id))) return;
    await this.pg.query(
      `UPDATE product_actions
          SET status = $2, result = $3::jsonb, resolved_at = now(), secrets_box = NULL,
              product_id = COALESCE($4::uuid, product_id)
        WHERE id = $1 AND status = 'working'`,
      [id, status, JSON.stringify(result), productId || null],
    );
  }

  /**
   * working-карточки без исхода. Два случая:
   *   - процесс умер между claim и finish/release (обрыв с базой, падение) —
   *     у карточки нет задания, и срок в прошлом больше чем на 10 минут
   *     отличает мертвеца от живой операции (сама работа — секунды);
   *   - смена ключей: задание rekey сняли снаружи (сборщик зависших,
   *     удаление продукта, блокировка) — исход в карточку не записан. Такая
   *     карточка закрывается без ожидания срока, с причиной по тому, успел
   *     ли агент забрать задание (см. CASE ниже).
   * Карточку с ЖИВЫМ заданием (queued/running) не трогаем ни при каком сроке:
   * отправленная на 29-й минуте, она иначе умерла бы при работающем агенте.
   * done — туда же: completeRekeyJob закрывает задание и карточку ОДНИМ
   * оператором (см. его докблок в provisioning.service.ts), поэтому снаружи
   * статусы «задание done» и «карточка working» видны одновременно только
   * если тот оператор не нашёл карточку в working (её закрыли откуда-то ещё
   * в то же мгновение) — то есть ключи, возможно, уже заменены и перенесены
   * в products.secrets_encrypted. Трогать такую карточку здесь — соврать
   * «не вышло» поверх настоящего успеха; честнее оставить её человеку на
   * разбор (ровно как позднее сообщение об успехе в plan item 18).
   *
   * expires_at у working НЕ продлевается claim-ом (он остаётся таким же,
   * каким был у pending) — поэтому срок в прошлом у working-строки надёжно
   * отличает мертвеца от долгой, но живой операции: сама работа (проверка
   * токена, один SQL) занимает секунды, а не минуты. Запас 10 минут — чтобы
   * не подмести карточку, которую в эту секунду как раз обрабатывает живой
   * процесс на грани истечения срока.
   *
   * Вторым оператором — стирание коробок у закрытых карточек: страховка на
   * случай закрытия мимо finish/release (ручная правка, будущий код).
   * status <> 'working', а не список терминальных статусов: ловит и pending
   * (куда коробка по инварианту не должна попадать вовсе — open() её не
   * пишет, release() стирает сам) тем же условием, без необходимости
   * перечислять статусы второй раз и забыть добавить новый.
   */
  async sweepStuck(): Promise<number> {
    const r = await this.pg.query(
      `UPDATE product_actions a
          SET status = 'failed',
              secrets_box = NULL,
              -- Причина — по тому, ДОШЛО ли задание до агента: забранное
              -- (started_at есть) и снятое снаружи — исход на машине
              -- неизвестен; не забранное — ключи точно не менялись, и текст
              -- называет, кто снял (удаление, блокировка, сборщик).
              -- Карточка ключей (kind = 'keys') без задания вообще — ключи
              -- заведомо не менялись (заведение задания и отправка карточки —
              -- один оператор, ProductKeysService), поэтому ей сразу идёт тот
              -- же текст и reason, что у «не забравшего» случая, а не общая
              -- формулировка для прочих видов действий.
              result = CASE
                WHEN NOT EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = a.id) AND a.kind = 'keys'
                  THEN jsonb_build_object('error', $1::text, 'reason', 'rekey_failed')
                WHEN NOT EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = a.id)
                  THEN jsonb_build_object('error', 'Действие прервалось — попросите ассистента повторить')
                WHEN EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = a.id AND j.started_at IS NOT NULL)
                  THEN jsonb_build_object('error', $2::text, 'reason', 'rekey_unknown')
                WHEN EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = a.id AND j.error = $5::text)
                  THEN jsonb_build_object('error', $3::text, 'reason', 'gone')
                WHEN EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = a.id AND j.error = $6::text)
                  THEN jsonb_build_object('error', $4::text, 'reason', 'blocked')
                ELSE jsonb_build_object('error', $1::text, 'reason', 'rekey_failed')
              END,
              resolved_at = now()
        WHERE a.status = 'working'
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.action_id = a.id AND j.status IN ('queued','running','done'))
          AND (EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = a.id AND j.status = 'failed')
               OR a.expires_at < now() - interval '10 minutes')
       RETURNING a.id`,
      [REKEY_FAILED_SAY, REKEY_UNKNOWN_SAY, REKEY_GONE_SAY, REKEY_BLOCKED_SAY, JOB_KILLED_BY_DELETE, JOB_KILLED_BY_BLOCK],
    );
    await this.pg.query(
      `UPDATE product_actions SET secrets_box = NULL WHERE secrets_box IS NOT NULL AND status <> 'working'`,
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
