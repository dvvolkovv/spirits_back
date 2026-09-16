import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

/**
 * Месячная аренда продукта — около 149 ₽ по цене пакета starter. Решение
 * владельца от 16.09.2026. Одно место на весь код: число, вшитое в текст
 * запроса, разъедется с константой молча.
 */
export const RENT_TOKENS = 50_000;

@Injectable()
export class RentService {
  private readonly logger = new Logger(RentService.name);

  constructor(private readonly pg: PgService) {}

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
   * уже сдвинутый период, то есть платит дважды за один месяц.
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
   * честно не делает ничего. Замок берётся на строку баланса раньше, чем на
   * строку продукта, и одинаково во всех вызовах — цикла ожиданий не
   * образуется.
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
}
