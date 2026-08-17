import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import {
  medianSpend,
  shouldWarn,
  WarnMark,
} from './consumption-rate';

/** Выше этого остатка прогноз не нужен — и запрос за медианой не делаем. */
const FORECAST_BALANCE_CEILING = 30000;

/** За сколько дней смотрим расход для медианы. */
const FORECAST_WINDOW_DAYS = 14;

/**
 * Ссылка абсолютная, а не /chat?view=tokens: модель воспроизводит её текстом,
 * и относительный путь в ответе, уехавшем в мобильное приложение или в
 * пересланное сообщение, никуда не ведёт.
 */
export const TOP_UP_URL = 'https://my.linkeon.io/chat?view=tokens';

/**
 * Склонение «сообщение» после числа. Блок инструкции пишется по-русски, и
 * «примерно на 1 сообщений» — брак, который уезжает прямо в промпт модели.
 *
 * Категории берём у Intl.PluralRules, а не выписываем правила руками: у
 * русского их три (one/few/many) и границы неочевидны — 21 это `one`, 23 —
 * `few`, 25 — `many`.
 */
const RU_PLURALS = new Intl.PluralRules('ru-RU');
const MESSAGE_FORMS: Record<string, string> = {
  one: 'сообщение',
  few: 'сообщения',
  many: 'сообщений',
  other: 'сообщения',
};
function messagesWord(n: number): string {
  return MESSAGE_FORMS[RU_PLURALS.select(n)] ?? 'сообщений';
}

/**
 * Блок про баланс для системного промпта ассистента.
 *
 * Устроен как TasksService.buildContextForPrompt: единственный публичный
 * метод, готовая строка или пустая. Баланс приходит аргументом — шлагбаум в
 * ChatService.streamChat уже прочитал его парой строк выше, и второй SELECT
 * на каждый ход не нужен.
 *
 * Решение «пора предупредить» принимает этот сервис, а не модель: модель не
 * держит счётчики между ходами и напоминала бы про баланс в каждом ответе.
 */
@Injectable()
export class BalanceContextService {
  private readonly logger = new Logger(BalanceContextService.name);

  constructor(private readonly pg: PgService) {}

  /// [opts.storeBuild] — запрос пришёл из сборки для App Store или Google Play.
  ///
  /// Тогда ссылки на пополнение в промпте быть НЕ ДОЛЖНО. Правило 3.1.1
  /// считает нарушением любую точку доступа к оплате мимо биллинга магазина, и
  /// отказ 17.08.2026 пришёл именно за такую ссылку: у проверяющего кончились
  /// токены, и ассистент честно выдал ему адрес оплаты на сайте.
  ///
  /// Баланс при этом называть можно — это факт о счёте, а не предложение
  /// купить. Убираем только указание, куда идти платить.
  async buildContextForPrompt(
    userId: string,
    balance: number,
    opts: { isGreeting?: boolean; storeBuild?: boolean } = {},
  ): Promise<string> {
    try {
      const forecast = await this.forecastMessages(userId, balance);

      let block = `--- Баланс пользователя ---\n`;
      block += forecast == null
        ? `На счету ${balance} токенов.\n`
        : `На счету ${balance} токенов — примерно на ${forecast} ${messagesWord(forecast)} при его обычном расходе.\n`;
      block +=
        `Сам про баланс не заговаривай. Если спросят, сколько осталось — назови эту цифру, ` +
        `не выдумывай и не округляй.\n` +
        `Если инструмент вернул ошибку insufficient_tokens — объясни спокойно, что на эту ` +
        `операцию не хватает токенов, назови, сколько нужно и сколько есть. ` +
        (opts.storeBuild
          ? `НЕ давай ссылок на пополнение и НЕ объясняй, где купить токены: ` +
            `в этой сборке приложения оплата недоступна. Ограничься фактом.\n`
          : `Дай ссылку ${TOP_UP_URL}.\n`) +
        `Не пробуй тот же инструмент повторно.\n`;

      if (await this.grantWarning(userId, balance, opts.isGreeting)) {
        block +=
          `Баланс на исходе, и пользователя об этом ещё не предупреждали. Один раз, в конце ` +
          `этого ответа, коротко и без давления скажи, что токены заканчиваются` +
          (opts.storeBuild
            ? `. Ссылку на пополнение НЕ давай и не объясняй, где купить.\n`
            : `, и дай ссылку: [Пополнить баланс](${TOP_UP_URL}).\n`) +
          `Не выноси это в отдельное сообщение и не повторяй в следующих ответах.\n`;
      }

      return block;
    } catch (e: any) {
      // Блок про баланс — украшение хода, а не его условие: сломанный запрос
      // не должен стоить пользователю ответа ассистента.
      this.logger.warn(`не удалось собрать блок баланса для ${userId}: ${e?.message}`);
      return '';
    }
  }

  /** Сколько примерно сообщений осталось, или null если считать не на чем. */
  private async forecastMessages(userId: string, balance: number): Promise<number | null> {
    if (balance >= FORECAST_BALANCE_CEILING) return null;

    // ABS обязателен: расход в token_transactions лежит отрицательным числом
    // (см. ABS(SUM(amount)) в admin.service.ts:1149). medianSpend отбрасывает
    // неположительные значения как мусор, так что без ABS сюда не доехал бы
    // ни один замер и прогноз молча исчез бы навсегда.
    const res = await this.pg.query(
      `SELECT ABS(amount) AS amount FROM token_transactions
        WHERE user_id = $1
          AND transaction_type = 'consumed'
          AND created_at > now() - ($2 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT 200`,
      [userId, String(FORECAST_WINDOW_DAYS)],
    );

    const median = medianSpend(res.rows.map((r: any) => Number(r.amount)));
    if (median == null || median <= 0) return null;

    return Math.max(1, Math.floor(balance / median));
  }

  /**
   * Выдать разрешение предупредить и сразу поставить отметку.
   *
   * Отметка ставится по факту ВЫДАЧИ разрешения, а не по факту произнесённой
   * ассистентом фразы. Проверить второе можно было бы только регуляркой по
   * тексту ответа — ровно тот класс проверок, который уже ломался у нас после
   * перевода на семь языков. Если модель проигнорирует инструкцию, следующее
   * окно откроется через сутки; предупредить с опозданием лучше, чем дважды
   * подряд.
   */
  private async grantWarning(
    userId: string,
    balance: number,
    isGreeting?: boolean,
  ): Promise<boolean> {
    const res = await this.pg.query(
      `SELECT profile_data->'low_balance_warned' AS warned
         FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    const warned = (res.rows[0]?.warned ?? null) as WarnMark | null;

    if (!shouldWarn({ balance, warned, now: Date.now(), isGreeting })) return false;

    const upd = await this.pg.query(
      `UPDATE ai_profiles_consolidated
          SET profile_data = jsonb_set(
                coalesce(profile_data, '{}'::jsonb),
                '{low_balance_warned}',
                $2::jsonb,
                true
              )
        WHERE user_id = $1`,
      [userId, JSON.stringify({ at: new Date().toISOString(), atBalance: balance })],
    );

    // Отметку записать не удалось — молчим. Postgres на несуществующем
    // user_id отрабатывает БЕЗ ошибки и трогает ноль строк, так что выдать
    // здесь разрешение значило бы предупреждать заново каждый ход: запомнить
    // выданное разрешение негде. Лучше не предупредить, чем зациклиться.
    if (!upd.rowCount) {
      this.logger.warn(`отметка о предупреждении не записана: нет строки профиля у ${userId}`);
      return false;
    }
    return true;
  }
}
