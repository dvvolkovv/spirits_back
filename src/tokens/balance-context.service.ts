import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import {
  medianSpend,
  shouldWarn,
  warnCycleExpired,
  WarnMark,
} from './consumption-rate';

/** Выше этого остатка прогноз не нужен — и запрос за медианой не делаем. */
const FORECAST_BALANCE_CEILING = 30000;

/** За сколько дней смотрим расход для медианы. */
const FORECAST_WINDOW_DAYS = 14;

/**
 * Остаток «на один-два ответа»: дальше шлагбаум нуля оборвёт разговор, и
 * ассистенту пора бережно закрывать смысловой блок (находка a3da5a2b —
 * психологическую практику свернули на остатке в один ответ).
 *
 * При прогнозе max(1, floor(balance/median)) порог «≤ 2» равносилен условию
 * «баланс меньше трёх медиан хода»: на балансе от трёх медиан и выше прогноз
 * уже выйдет ≥ 3.
 */
const NEAR_EMPTY_ANSWERS = 2;

/**
 * Без прогноза (мало замеров) — тот же смысл по сумме: «красный» порог
 * витрины (spirits_front src/config/balanceThresholds.ts, CRITICAL_BALANCE).
 * Число одно и то же не случайно: фраза «баланс почти закончился» не должна
 * противоречить цвету плашки на экране в тот же момент.
 */
const NEAR_EMPTY_FALLBACK_TOKENS = 2000;

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
  ///
  /// [opts.assistantId] — id текущего ассистента (streamChat передаёт
  /// agent.id, см. resolveAgent): для медианы расхода по дорогому ассистенту,
  /// см. forecastMessages. Строка вида `custom:…` или не-целое — пользовательский
  /// ассистент, медиану пары по нему не считаем.
  async buildContextForPrompt(
    userId: string,
    balance: number,
    opts: { isGreeting?: boolean; storeBuild?: boolean; assistantId?: string } = {},
  ): Promise<string> {
    try {
      // В магазинной сборке баланса нет вовсе — ни на экране, ни в разговоре.
      //
      // Apple отклоняла четырежды по правилу 3.1.1 за доступ к оплаченному вне
      // приложения. Сначала убрали витрину, потом ссылку на пополнение, потом
      // купон — не помогло: претензия к самому балансу. Решение владельца:
      // в iOS его не показывать и не упоминать. Ассистент, называющий цифру,
      // — то же самое разглашение другим способом.
      if (opts.storeBuild) return '';

      const forecast = await this.forecastMessages(userId, balance, opts.assistantId);

      let block = `--- Баланс пользователя ---\n`;
      block += forecast == null
        ? `На счету ${balance} токенов.\n`
        : `На счету ${balance} токенов — примерно на ${forecast} ${messagesWord(forecast)} при его обычном расходе.\n`;
      block +=
        `Сам про баланс не заговаривай, кроме случаев, когда ниже прямо сказано ` +
        `предупредить. Если спросят, сколько осталось — назови эту цифру, не выдумывай ` +
        `и не округляй.\n` +
        `Если инструмент вернул ошибку insufficient_tokens — объясни спокойно, что на эту ` +
        `операцию не хватает токенов, назови, сколько нужно и сколько есть. Дай ссылку ` +
        `${TOP_UP_URL}.\n` +
        `Не пробуй тот же инструмент повторно.\n`;

      // Остаток «на 1-2 ответа» — не обычное предупреждение, а инструкция
      // бережно завершить смысловой блок: за ним придёт шлагбаум нуля, и
      // практику/упражнение правильнее закрыть сейчас, а не бросить на
      // полуслове (находка a3da5a2b).
      const nearEmpty = !opts.isGreeting && (forecast == null
        ? balance < NEAR_EMPTY_FALLBACK_TOKENS
        : forecast <= NEAR_EMPTY_ANSWERS);

      if (nearEmpty) {
        // Низкобалансовое разрешение расходуем тут же — иначе следующим ходом
        // (баланс всё ещё низкий, но уже не near-empty) пришло бы ещё и
        // обычное предупреждение поверх завершения.
        await this.grantWarning(userId, balance, opts.isGreeting);

        // Число сообщений (forecast) уже названо строкой выше, в постоянной
        // части блока («примерно на N сообщений при его обычном расходе») —
        // здесь его не повторяем, только ссылаемся на него (находка ревью).
        const left = forecast == null
          ? `Баланс почти закончился — меньше ${NEAR_EMPTY_FALLBACK_TOKENS} токенов.`
          : `Баланс почти закончился — прогноз выше.`;

        // «Сказано один раз» решает СЕРВЕР через отдельную отметку
        // (near_empty_told), а не модель по истории разговора: окно
        // «остаток на 1-2 ответа» может держаться несколько ходов подряд, и
        // без детерминированной отметки инструкция с ссылкой повторялась бы
        // каждый раз (находка ревью качества 02.11, I2).
        const firstTime = await this.grantNearEmptyNotice(userId, balance);
        block += firstTime
          ? `${left} На текущий вопрос ответь как обычно. Сам не предлагай начинать новую ` +
            `практику или многошаговую работу; если человек просит её сам — скажи, на ` +
            `сколько примерно хватит, и предложи короткий вариант. Если идёт практика или ` +
            `упражнение — в этом ответе помоги бережно завершить текущий смысловой блок: ` +
            `подведи итог, дай опору или следующий шаг на потом. Можно сказать, что ` +
            `продолжить получится после пополнения: [Пополнить баланс](${TOP_UP_URL}).\n`
          : `${left} Про пополнение ты уже сказал — не повторяй; бережно закрывай смысловой блок.\n`;
      } else if (await this.grantWarning(userId, balance, opts.isGreeting)) {
        // Без прогноза число выдумывать нельзя (medianSpend: «выдуманная
        // цифра хуже её отсутствия») — тогда инструкция просит сказать о
        // нехватке без числа, а не «сколько примерно ответов хватит»
        // (находка ревью качества 02.11, I1).
        const amountHint = forecast == null
          ? `скажи, что токенов мало и длинная практика может не уместиться`
          : `скажи, что хватит примерно на ${forecast} ${messagesWord(forecast)}`;
        block +=
          `Баланс на исходе, и пользователя об этом ещё не предупреждали. Скажи один раз, в ` +
          `этом ответе, коротко и без давления, что токены заканчиваются, и дай ссылку: ` +
          `[Пополнить баланс](${TOP_UP_URL}).\n` +
          `Выбери место бережно: если вы начинаете практику, упражнение или длинную задачу — ` +
          `до её начала ${amountHint}, чтобы человек решил, успеете ли; ` +
          `если человек делится переживаниями или упражнение уже идёт — не вставляй это ` +
          `посреди, а скажи одной мягкой фразой в самом конце ответа, когда мысль закончена. ` +
          `Никогда не прерывай упражнение ради этого.\n` +
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
  private async forecastMessages(userId: string, balance: number, assistantId?: string): Promise<number | null> {
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
    const userMedian = medianSpend(res.rows.map((r: any) => Number(r.amount)));

    // Медиана по ПАРЕ пользователь+ассистент — отдельно от общей по всем
    // сообщениям пользователя. У дорогого агентного ассистента (файлы,
    // субагенты) ход может стоить в 10-30 раз больше медианы переписки, и
    // общая медиана тогда обманывает: баланса хватит на один такой ход, а
    // прогноз обещает двадцать (находка a3da5a2b — агентные ходы Романа при
    // медиане пользователя ~400). Берём бОльшую из двух медиан — для
    // дешёвого ассистента она совпадёт с общей, для дорогого станет честной.
    //
    // agent_id разбираем тем же способом, что admin.service.ts.addTokenTask:
    // только целое число. Кастомный ассистент (`custom:…`) или отсутствующий
    // id — медиану пары не считаем вовсе.
    let pairMedian: number | null = null;
    const agentId = assistantId && /^\d+$/.test(assistantId) ? parseInt(assistantId, 10) : null;
    if (agentId != null) {
      // Таблица без индекса по (user_id, agent_id) — seq scan по ~50 тыс.
      // строк, ~9 мс и растёт. Ветка НЕ редкая: приветственный бонус новым
      // пользователям — 25 000 токенов, это МЕНЬШЕ FORECAST_BALANCE_CEILING
      // (30 000) — так что у заметной доли пользователей запрос уходит почти
      // на каждом ходе, а не только «когда баланс уже низкий». Нужен индекс
      // token_consumption_tasks (user_id, agent_id, created_at DESC); в
      // стартовую миграцию его не класть — у проекта CREATE INDEX в
      // стартовой миграции держит ShareLock на таблице при каждом старте
      // приложения. Заводится отдельно, вручную, CREATE INDEX CONCURRENTLY.
      const pairRes = await this.pg.query(
        `SELECT tokens_to_consume AS amount FROM token_consumption_tasks
          WHERE user_id = $1 AND agent_id = $2
            AND tokens_to_consume > 0
            AND created_at > now() - ($3 || ' days')::interval
          ORDER BY created_at DESC
          LIMIT 200`,
        [userId, agentId, String(FORECAST_WINDOW_DAYS)],
      );
      pairMedian = medianSpend(pairRes.rows.map((r: any) => Number(r.amount)));
    }

    const median = pairMedian == null
      ? userMedian
      : (userMedian == null ? pairMedian : Math.max(userMedian, pairMedian));
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

  /**
   * Отметка «уже сказал про бережное завершение» (profile_data.near_empty_told)
   * — свой цикл, НЕЗАВИСИМЫЙ от low_balance_warned: окно «остаток на 1-2
   * ответа» может держаться несколько ходов подряд, и без отдельной
   * детерминированной отметки инструкция с ссылкой повторялась бы каждый ход
   * — решала бы это модель по истории разговора, а не сервер (та же причина,
   * по которой устроен grantWarning).
   *
   * Цикл истекает по общему правилу (warnCycleExpired): через сутки или
   * после пополнения. Не переиспользуем shouldWarn целиком — у него свой
   * порог LOW_BALANCE_THRESHOLD (10 000), а near_empty у дорогого ассистента
   * может наступить и при балансе заметно выше.
   */
  private async grantNearEmptyNotice(userId: string, balance: number): Promise<boolean> {
    const res = await this.pg.query(
      `SELECT profile_data->'near_empty_told' AS told
         FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    const told = (res.rows[0]?.told ?? null) as WarnMark | null;

    if (!warnCycleExpired(told, balance, Date.now())) return false;

    const upd = await this.pg.query(
      `UPDATE ai_profiles_consolidated
          SET profile_data = jsonb_set(
                coalesce(profile_data, '{}'::jsonb),
                '{near_empty_told}',
                $2::jsonb,
                true
              )
        WHERE user_id = $1`,
      [userId, JSON.stringify({ at: new Date().toISOString(), atBalance: balance })],
    );

    // Та же защита, что в grantWarning: строки профиля нет — запомнить
    // негде, и отдать «это впервые» значило бы повторять полную инструкцию
    // с ссылкой каждый ход. Короткое напоминание без ссылки — безопасный
    // дефолт на случай, когда мы не можем подтвердить, что это первый раз.
    if (!upd.rowCount) {
      this.logger.warn(`отметка near_empty_told не записана: нет строки профиля у ${userId}`);
      return false;
    }
    return true;
  }
}
