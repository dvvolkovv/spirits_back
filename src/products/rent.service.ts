import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TURN_SILENCE_SQL } from './turns.service';

/**
 * Месячная аренда продукта — около 149 ₽ по цене пакета starter. Решение
 * владельца от 16.09.2026. Одно место на весь код: число, вшитое в текст
 * запроса, разъедется с константой молча.
 */
export const RENT_TOKENS = 50_000;

/**
 * ═══ ПОРЯДОК ЗАМКОВ В ЭТОМ МОДУЛЕ: БАЛАНС, ПОТОМ ПРОДУКТ ═══
 *
 * Списание аренды — единственное место в проекте, которое берёт в ОДНОМ
 * операторе две строки: сначала `ai_profiles_consolidated` (достаток под
 * `FOR UPDATE`), потом `products` (занятие периода). Проверено приборно:
 * обратный порядок в соседней транзакции даёт настоящий deadlock, а не
 * замедление.
 *
 * Сегодня цикла нет — ни один другой путь не держит обе строки в одной
 * транзакции: ходы списывают через `consume_user_tokens` (только баланс),
 * заведение и сон трогают только продукт. Но цикл конструируется тривиально:
 * достаточно где-нибудь взять строку продукта и уже под ней пойти списывать
 * токены. КТО БУДЕТ ЭТО ПИСАТЬ — берите строки в том же порядке: баланс
 * раньше продукта. Обратный порядок не падает на тестах и не виден в логе: он
 * проявляется под нагрузкой, как случайные 40P01 у части списаний.
 *
 * Отдельно: замок защищает только от тех писателей, которые его БЕРУТ.
 * `add_user_tokens` (пополнение) читает баланс без замка и пишет посчитанное
 * значение целиком, поэтому пополнение, пришедшее ровно в момент списания,
 * возвращает владельцу деньги за уже занятый месяц. Это чужая и старая дыра —
 * тот же танец с `consume_user_tokens` даёт тот же результат, — и чинится она
 * в самой процедуре пополнения, а не здесь.
 */

/** Раз в сутки. Период — месяц, чаще незачем; реже значит держать
 *  неоплаченный продукт запущенным лишние сутки. */
const TICK_MS = 24 * 60 * 60 * 1000;

/** Первый оборот не в момент старта: рестарт API не должен лезть в базу за
 *  списаниями, пока модуль ещё поднимается. */
const FIRST_TICK_MS = 60 * 1000;

/** Человеческий текст для карточки. Признак для запросов — status, см. 004. */
export const SLEEP_REASON_NO_TOKENS = 'Не хватило токенов на аренду';

@Injectable()
export class RentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RentService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly pg: PgService) {}

  onModuleInit() {
    // catch на каждом вызове: `void this.tick()` из плана превращает любую
    // ошибку в unhandled rejection, а в этом процессе она валит его целиком.
    setTimeout(() => this.safeTick(), FIRST_TICK_MS).unref?.();
    this.timer = setInterval(() => this.safeTick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private safeTick() {
    this.tick().catch((e: any) => this.logger.error(`оборот аренды упал: ${e?.message ?? e}`));
  }

  /**
   * Списать аренду за очередной месяц. true — деньги взяты и период занят.
   *
   * ОДИН ОПЕРАТОР, и это не стилистика. Прод работает в кластере из двух
   * процессов, и точка сериализации здесь — блокировка строки продукта:
   * второй процесс встаёт на замке, после коммита первого перечитывает строку
   * (EvalPlanQual), видит `paid_until` уже в будущем и не находит ничего.
   * Транзакции из кода тут не будет: `BEGIN` через пул на этом проекте уже
   * давал код, рапортующий об откате, которого не было.
   *
   * ПОРЯДОК ЧАСТЕЙ. Сначала занять период, потом списать. Наоборот — значит
   * списать и не занять: второй процесс кластера снимает деньги и упирается в
   * уже сдвинутый период, то есть платит дважды за один месяц. Проверяется
   * сценарием 36 и только им: в сценарии 22, где сборщики просто стартуют
   * одновременно, перевёрнутый порядок остаётся ЗЕЛЁНЫМ, если второй запрос
   * успел взять снимок уже после чужого коммита. Найдено мутацией.
   *
   * ПОЧЕМУ НЕ `misc.deductTokens`. Он идёт через `consume_user_tokens`, а та
   * при нехватке забирает СКОЛЬКО ЕСТЬ и возвращает это число (прочитано на
   * проде: `IF v_current_balance >= p_amount THEN … ELSE v_actual_amount :=
   * v_current_balance`). Для правки это верно — работа сделана, услуга
   * оказана. Для аренды это худший из исходов: денег взяли не сколько надо,
   * продукт всё равно заснёт, а баланс обнулён. По той же причине здесь
   * запрещён и `GREATEST(0, tokens - …)`: это тот же частичный расход, только
   * своими руками.
   *
   * ПОЧЕМУ БАЛАНС ЧИТАЕТСЯ ПОД ЗАМКОМ (`FOR UPDATE` в подзапросе достатка).
   * Без него достаток проверяется по снимку начала оператора, а списание
   * применяется к той версии строки, которая есть на момент записи, — и между
   * ними помещается целый ход. Измерено на живой базе (PostgreSQL 16,
   * 16.09.2026): баланс 60 000, параллельная правка забирает 20 000; без
   * замка аренда оставляет владельцу НОЛЬ (взяли 40 000 из нужных 50 000) и
   * засчитывает месяц, с замком — оператор ждёт 714 мс, перечитывает 40 000 и
   * честно не делает ничего.
   *
   * ГРАНИЦА ЭТОЙ ЗАЩИТЫ. Замок держит только тех писателей, которые его берут:
   * ходы (`consume_user_tokens`) и соседние списания аренды. Пополнение
   * (`add_user_tokens`) баланс под замок НЕ берёт и пишет посчитанное
   * значение целиком, поэтому пополнение ровно в момент списания возвращает
   * владельцу деньги за уже занятый месяц. Дыра чужая и старая (тот же танец с
   * `consume_user_tokens` даёт тот же исход) и чинится в самой процедуре
   * пополнения. Порядок замков в модуле — в блоке ПОРЯДОК ЗАМКОВ наверху
   * файла.
   *
   * МЕСЯЦ ОТСЧИТЫВАЕТСЯ ОТ ЗАНЯТОГО СРОКА, А НЕ ОТ `now()`. Пока просрочка
   * меньше месяца (штатный случай: сборщик ходит раз в сутки), якорь даты
   * сохраняется — иначе он уезжал бы вперёд на время запаздывания сборщика,
   * то есть до суток в месяц бесплатного хостинга. Но если срок истёк давно —
   * продукт проспал три месяца, сборщик стоял, — от `paid_until` месяц
   * прибавлять нельзя: получится оплата периода, который уже прошёл, и на
   * следующем обороте такой продукт заплатит снова. Спека: спящий долг не
   * копит. Поэтому просроченный больше чем на месяц платит РОВНО ЗА ОДИН
   * месяц вперёд, от сегодняшнего дня. Проверено исполнением обоих случаев.
   *
   * ЧТО ВОЗВРАЩАЕТСЯ. Ответ оператора — одна строка со счётчиками ВСЕГДА,
   * поэтому `rowCount` тут равен единице и при полном отказе; правда живёт в
   * числе списаний. Расхождение «период занят, а денег не взяли» означало бы
   * бесплатный месяц: при исправном замке оно недостижимо, но если случится —
   * это строка в логе, а не тишина, иначе узнать о нём можно только по
   * недосчитанной выручке.
   */
  async chargeRent(productId: string): Promise<boolean> {
    const r = await this.pg.query(
      `WITH claimed AS (
          UPDATE products p
             SET paid_until = CASE
                   WHEN p.paid_until + interval '1 month' > now()
                     THEN p.paid_until + interval '1 month'
                     ELSE now() + interval '1 month'
                 END
           WHERE p.id = $1
             AND p.archived_at IS NULL
             AND p.status IN ('running','degraded')
             AND p.paid_until <= now()
             AND EXISTS (SELECT 1
                           FROM ai_profiles_consolidated a
                          WHERE a.user_id = p.user_id
                            AND a.tokens >= $2
                          FOR UPDATE)
          RETURNING p.id AS product_id, p.user_id, p.slug, p.paid_until
       ), charged AS (
          UPDATE ai_profiles_consolidated a
             SET tokens = a.tokens - $2, updated_at = now()
            FROM claimed c
           WHERE a.user_id = c.user_id
             AND a.tokens >= $2
          RETURNING a.user_id, a.tokens AS balance_after
       ), logged AS (
          INSERT INTO token_transactions
                 (user_id, transaction_type, amount, balance_after, description, metadata)
          SELECT ch.user_id, 'consumed', -($2::bigint), ch.balance_after,
                 'Аренда продукта ' || c.slug || ' — месяц',
                 jsonb_build_object('kind', 'product_rent',
                                    'product_id', c.product_id,
                                    'paid_until', c.paid_until)
            FROM charged ch JOIN claimed c ON c.user_id = ch.user_id
          RETURNING id
       )
       SELECT (SELECT count(*) FROM claimed) AS claimed,
              (SELECT count(*) FROM charged) AS charged,
              (SELECT count(*) FROM logged)  AS logged`,
      [productId, RENT_TOKENS],
    );

    // count(*) — bigint, node-pg отдаёт его строкой. Number() здесь не
    // косметика: '0' в JS — истина.
    const row = r.rows?.[0] ?? {};
    const claimed = Number(row.claimed ?? 0);
    const charged = Number(row.charged ?? 0);
    const logged = Number(row.logged ?? 0);

    if (claimed !== charged) {
      this.logger.error(
        `аренда продукта ${productId}: период занят ${claimed} раз, списаний ${charged} — ` +
          'месяц выдан бесплатно, проверь замок на строке баланса',
      );
    } else if (charged !== logged) {
      // Деньги взяты, а в учёте их нет: владелец увидит минус 50 000 без
      // объяснения. Ломать из-за этого списание нечем — просто говорим вслух.
      this.logger.error(
        `аренда продукта ${productId}: списаний ${charged}, строк в учёте ${logged} — ` +
          'расход не попал в историю токенов',
      );
    }

    return charged > 0;
  }

  /**
   * Оборот сборщика: обойти тех, у кого истёк оплаченный период.
   *
   * ПО ОДНОМУ ПРОДУКТУ И КАЖДЫЙ В СВОЁМ ОПЕРАТОРЕ. Один битый продукт не
   * должен останавливать списание у остальных: узнать об этом можно было бы
   * только по недосчитанной выручке.
   *
   * РАЗНИЦА МЕЖДУ «НЕ СПИСАЛОСЬ» И «БАЗА УПАЛА» здесь и живёт. `chargeRent`
   * ошибку не глотает намеренно: проглоченная означала бы «не хватило денег»,
   * и одно моргание соединения усыпило бы разом все продукты, каждый из
   * которых пришлось бы будить руками. Поэтому исключение ловится тут и
   * ведёт НЕ к сну, а к строке в логе и к следующему обороту.
   *
   * «Не списалось» тоже не равно «нечем платить»: прод работает в двух
   * процессах, и false у проигравшего значит «сосед только что заплатил». Сон
   * от этого защищён не здесь, а предусловием внутри requestSleep
   * (`paid_until <= now()`) — проверять состояние здесь значило бы вводить
   * окно между проверкой и действием.
   */
  async tick(): Promise<void> {
    const due = await this.pg.query(
      `SELECT id FROM products
        WHERE archived_at IS NULL
          AND status IN ('running','degraded')
          AND paid_until <= now()
        ORDER BY paid_until`,
    );
    for (const row of due.rows) {
      try {
        if (await this.chargeRent(row.id)) continue;
        if (await this.requestSleep(row.id)) {
          this.logger.warn(`продукт ${row.id}: не хватило токенов на аренду — поставлен сон`);
        }
      } catch (e: any) {
        this.logger.error(`аренда продукта ${row.id}: ${e?.message ?? e}`);
      }
    }
  }

  /**
   * Поставить задание «усыпить». true — задание встало и продукт помечен
   * спящим.
   *
   * СОН ЖДЁТ ХОДА. Ассистент в контейнере пишет код; погашенный посреди этого
   * контейнер убивает правку МОЛЧА: ни ошибки, ни строки в истории, ни
   * списания. Признак живого хода — не длительность, а молчание, и потолок
   * берётся из общей с `turns.reapStuck` константы: свой, выбранный заново,
   * разъехался бы с ней молча. Что живым НЕ считается: ход, молчащий дольше
   * потолка (его через несколько минут похоронит сборщик зависших), и ход,
   * застрявший в очереди дольше потолка (раннер за ним так и не пришёл).
   * Иначе неоплаченный продукт работал бы, пока кто-нибудь не посмотрит в
   * базу руками.
   *
   * ПОРЯДОК ЧАСТЕЙ: СНАЧАЛА ЗАДАНИЕ, ПОТОМ СТАТУС. В плане было наоборот, и
   * это дыра: `ON CONFLICT DO NOTHING` молча пропускает вставку, когда у
   * продукта уже есть активное задание (например, идёт заведение), — а статус
   * при обратном порядке уже переведён в `sleeping`. Продукт с таким статусом
   * перестаёт платить аренду и не принимает правок, но контейнер его работает
   * и гасить его больше некому: заданий на него нет. Бесплатный хостинг,
   * видимый только по недосчитанной выручке.
   *
   * `FOR UPDATE` на строке продукта — точка сериализации: два одновременных
   * запроса сна дают одно задание, второй перечитывает строку и видит
   * `sleeping`.
   *
   * `paid_until <= now()` в предусловии — защита от собственного сборщика в
   * кластере: проигравший гонку процесс получает от chargeRent false и идёт
   * усыплять ОПЛАЧЕННЫЙ продукт. Здесь он не находит ничего.
   */
  async requestSleep(productId: string): Promise<boolean> {
    const r = await this.pg.query(
      `WITH picked AS (
          SELECT p.id
            FROM products p
           WHERE p.id = $1
             AND p.archived_at IS NULL
             AND p.status IN ('running','degraded')
             AND p.paid_until <= now()
             AND NOT EXISTS (
                   SELECT 1 FROM product_turns t
                    WHERE t.product_id = p.id
                      AND t.status IN ('queued','running')
                      AND COALESCE(t.last_progress_at, t.started_at, t.created_at)
                          > now() - ${TURN_SILENCE_SQL})
             FOR UPDATE
       ), queued AS (
          INSERT INTO product_provision_jobs (product_id, kind, status)
          SELECT pk.id, 'sleep', 'queued' FROM picked pk
          ON CONFLICT DO NOTHING
          RETURNING product_id
       )
       UPDATE products p
          SET status = 'sleeping', sleep_reason = $2
         FROM queued q
        WHERE p.id = q.product_id
       RETURNING p.id`,
      [productId, SLEEP_REASON_NO_TOKENS],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Разбудить спящие продукты владельца, на которые хватает баланса.
   * Возвращает число поставленных заданий.
   *
   * ПО ОДНОМУ ЗАДАНИЮ НА ПРОДУКТ И В ПОРЯДКЕ ЗАСЫПАНИЯ. Пополнение при
   * двадцати спящих иначе стартует двадцать контейнеров разом — отказ по
   * памяти на общей машине. Очередь разбирается по одному, от неё это и
   * требуется.
   *
   * СКОЛЬКО БУДИМ — целое число месяцев, которые владелец может оплатить.
   * Деньги здесь не резервируются и не списываются: аренду возьмёт ближайший
   * оборот сборщика, когда продукт вернётся в `running`. Отрицательный баланс
   * (в этом проекте такие были) даёт отрицательное число мест, то есть ноль
   * пробуждений — специально проверено, а не выведено.
   *
   * Продукты с уже активным заданием исключены ЯВНО, а не оставлены на
   * `ON CONFLICT`: иначе они занимали бы места в бюджете и тихо отнимали
   * пробуждение у соседей. `ON CONFLICT DO NOTHING` остаётся как гонка-щит —
   * он опирается на частичный уникальный индекс
   * `product_provision_jobs_one_active (product_id) WHERE status IN
   * ('queued','running')`, то есть на конфликт, который в базе действительно
   * есть.
   *
   * ЧЕГО ЗДЕСЬ НЕТ. Причина сна не различается: сегодня она одна (деньги), и
   * признаком служит статус, а не человеческий текст `sleep_reason`. Появится
   * второй повод спать — понадобится машинный признак, и вот тогда это место
   * станет неверным.
   *
   * ВНИМАНИЕ: `kind` есть у ОБЕИХ таблиц (у продукта — сайт или бот, у
   * задания — вид работы), поэтому в `picked` все ссылки уточнены префиксом.
   */
  async wakeAffordable(userId: string): Promise<number> {
    const r = await this.pg.query(
      `WITH budget AS (
          SELECT COALESCE(
                   (SELECT a.tokens FROM ai_profiles_consolidated a WHERE a.user_id = $1),
                   0) / $2 AS slots
       ), picked AS (
          SELECT p.id, row_number() OVER (ORDER BY p.paid_until, p.id) AS n
            FROM products p
           WHERE p.user_id = $1
             AND p.archived_at IS NULL
             AND p.status = 'sleeping'
             AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                              WHERE j.product_id = p.id
                                AND j.status IN ('queued','running'))
       )
       INSERT INTO product_provision_jobs (product_id, kind, status)
       SELECT pk.id, 'wake', 'queued'
         FROM picked pk CROSS JOIN budget b
        WHERE pk.n <= b.slots
       ON CONFLICT DO NOTHING
       RETURNING product_id`,
      [userId, RENT_TOKENS],
    );
    return r.rowCount ?? 0;
  }
}
