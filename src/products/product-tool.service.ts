import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { PRODUCT_TOOL_WAIT_MS } from '../common/relay-budget';
import { TurnsService, SLEEPING_REFUSAL, BLOCKED_REFUSAL } from './turns.service';

/** Продукт глазами ассистента: без внутренностей, только то, что можно назвать вслух. */
export interface ProductMatch {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  kind: string;
  status: string;
}

/** Строка хода, как её отдаёт product_turns. */
export interface TurnRowLike {
  id: string;
  status: string;
  result: string | null;
  error: string | null;
  tokens_spent: number | string | null;
}

export interface TurnOutcome {
  /**
   * Успех вызова с точки зрения ассистента. ОТКАТ И ПРОВАЛ — НЕ УСПЕХ:
   * контроллер MCP выставляет isError по !ok, и модель видит их как ошибку, а
   * не как результат, который легко пересказать словом «готово». Это главная
   * опасность работы.
   */
  ok: boolean;
  outcome: 'done' | 'reverted' | 'failed' | 'queued' | 'running';
  /** Ход кончился хоть как-нибудь. queued/running — ещё нет. */
  finished: boolean;
  turnId: string;
  result: string | null;
  error: string | null;
  tokensSpent: number;
  /** Человеческая формулировка. Ассистент пересказывает её, а не выдумывает свою. */
  say: string;
}

/**
 * Единственное место, где статус хода превращается в новость для человека.
 * Одно на `edit` и `status`: разъехавшись, они сказали бы про один и тот же ход
 * разное — и пересказ «готово» после отката стал бы вопросом того, каким путём
 * ассистент о ходе узнал.
 *
 * tokens_spent приезжает из node-pg СТРОКОЙ (bigint), поэтому приводится явно:
 * без Number() сложение склеило бы строки.
 */
export function describeTurn(row: TurnRowLike): TurnOutcome {
  const tokensSpent = Number(row.tokens_spent ?? 0) || 0;
  const base = { turnId: row.id, result: row.result ?? null, error: row.error ?? null, tokensSpent };
  switch (row.status) {
    case 'done':
      return { ...base, ok: true, outcome: 'done', finished: true,
        say: `Правка применена. Списано за ход: ${tokensSpent} токенов.` };
    case 'reverted':
      return { ...base, ok: false, outcome: 'reverted', finished: true,
        say: 'ПРАВКА НЕ ПРИМЕНЕНА: продукт не прошёл проверку здоровья, и код автоматически вернули как было. ' +
             'Скажи это пользователю прямо — не называй откат успехом.' };
    case 'failed':
      return { ...base, ok: false, outcome: 'failed', finished: true,
        say: 'ПРАВКА НЕ ВЫПОЛНЕНА: ход завершился ошибкой. Скажи это пользователю прямо.' };
    case 'queued':
      return { ...base, ok: true, outcome: 'queued', finished: false,
        say: 'Правка поставлена в очередь, но продукт её пока не забрал. Скажи, что задача принята, ' +
             'и предложи проверить через минуту действием status.' };
    default:
      return { ...base, ok: true, outcome: 'running', finished: false,
        say: 'Правка выполняется прямо сейчас. Скажи, что работа идёт, и предложи проверить действием status.' };
  }
}

@Injectable()
export class ProductToolService {
  private readonly logger = new Logger(ProductToolService.name);

  constructor(
    private readonly pg: PgService,
    private readonly turns: TurnsService,
  ) {}

  /**
   * Нестрогий поиск по имени плюс точные совпадения по слагу, домену и
   * идентификатору: последние три ассистент мог взять из `list` в том же
   * разговоре.
   *
   * Строгий разбор из BlockService.lookup() переиспользовать НЕЛЬЗЯ: он
   * отвечает «не найден» на «магазин цветов» при двух живых магазинах. Там
   * администратор приходит с доменом из жалобы и цена промаха — тихое гашение
   * чужого продукта; здесь цена — уточняющий вопрос.
   *
   * Владелец в WHERE, а не в проверке после выборки: разница между «нет
   * такого» и «есть, но не твой» — утечка существования чужих продуктов.
   */
  async resolve(userId: string, query: string): Promise<ProductMatch[]> {
    const raw = String(query ?? '').trim().toLowerCase();
    if (!raw) return [];
    // '%' и '_' — служебные символы LIKE. Без экранирования «100%» совпадает со
    // всем подряд, и ассистент получает «неоднозначно» там, где совпадение одно.
    const like = `%${raw.replace(/([\\%_])/g, '\\$1')}%`;
    const r = await this.pg.query(
      `SELECT id, name, slug, domain, kind, status
         FROM products
        WHERE user_id = $1 AND archived_at IS NULL
          AND ( id::text = $2
             OR lower(slug) = $2
             OR lower(domain) = $2
             OR lower(name) LIKE $3 )
        ORDER BY created_at DESC`,
      [userId, raw, like],
    );
    return r.rows;
  }

  /**
   * Единственный вход инструмента. Владелец — ПЕРВЫМ аргументом и приезжает из
   * проверенной подписи токена (см. точку /mcp/products), а не из поля
   * запроса: инструменту продуктов аргумента `userId` не дано вовсе.
   */
  async execute(userId: string, input: any): Promise<any> {
    const action = String(input?.action ?? '').trim();
    if (action === 'list') return this.list(userId);
    if (action === 'edit') return this.edit(userId, input);
    if (action === 'status') return this.status(userId, input);
    return {
      ok: false,
      reason: 'bad_action',
      say: 'Неизвестное действие. Доступны: list (показать продукты), edit (поставить правку), status (узнать исход правки).',
    };
  }

  private async list(userId: string) {
    const products = await this.pg
      .query(
        `SELECT id, name, slug, domain, kind, status
           FROM products
          WHERE user_id = $1 AND archived_at IS NULL
          ORDER BY created_at DESC`,
        [userId],
      )
      .then((r) => r.rows as ProductMatch[]);

    if (!products.length) {
      return {
        ok: true,
        products,
        say: 'У пользователя нет ни одного продукта. Завести продукт ты не можешь — это делается кнопкой ' +
             'в кабинете, вкладка «Продукты».',
      };
    }
    const hasBot = products.some((p) => p.kind === 'bot');
    return {
      ok: true,
      products,
      say:
        'Продукты пользователя. Правку ставь действием edit, назвав продукт именем.' +
        (hasBot ? ' У бота домена нет вовсе — это нормально, а не поломка: адрес есть только у сайтов.' : ''),
    };
  }

  /**
   * Потолок ожидания и шаг опроса — поля, а не константы в теле, ровно ради
   * тестов: сценарии «дождался» и «не дождался» иначе шли бы по 150 секунд
   * каждый. В работе не переопределяются никогда.
   */
  private waitMs = PRODUCT_TOOL_WAIT_MS;
  private pollMs = 2_000;

  private async edit(userId: string, input: any) {
    const prompt = String(input?.prompt ?? '').trim();
    if (!prompt) {
      return { ok: false, reason: 'no_prompt', say: 'Не сказано, что именно править. Спроси у пользователя и повтори вызов.' };
    }

    const matches = await this.resolve(userId, String(input?.product ?? ''));

    if (matches.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        matches,
        say: 'Под это описание подходит несколько продуктов. СПРОСИ у пользователя, какой именно править, ' +
             'и повтори вызов с точным именем или слагом. Не выбирай сам.',
      };
    }

    if (matches.length === 0) {
      const products = (await this.list(userId)).products;
      return {
        ok: false,
        reason: 'not_found',
        products,
        say: products.length
          ? 'Такого продукта у пользователя нет. Вот что есть — уточни, какой из них он имел в виду.'
          : 'У пользователя нет ни одного продукта. Завести продукт ты не можешь — это делается кнопкой в кабинете.',
      };
    }

    const product = matches[0];
    let turnId: string;
    try {
      const turn = await this.turns.enqueue({ productId: product.id, userId, channel: 'web', prompt });
      turnId = turn.id;
    } catch (e: any) {
      return this.refusal(e, product);
    }

    return { ...(await this.waitForOutcome(turnId)), product };
  }

  /**
   * Отказы `enqueue` разбираются по ЭКСПОРТИРОВАННЫМ константам, а не по
   * подстроке в тексте: тексты правят, и сверка по куску фразы разъезжается
   * молча. Сон и гашение обязаны остаться РАЗНЫМИ причинами — погашенному
   * нельзя предлагать пополнение, деньгами он не чинится (кабинет держит ту же
   * разницу кодами 402 и 409).
   */
  private refusal(e: any, product: ProductMatch) {
    const msg = typeof e?.response === 'string' ? e.response : (e?.response?.message ?? e?.message ?? '');
    if (msg === SLEEPING_REFUSAL) {
      return { ok: false, reason: 'sleeping', canTopUp: true, product, say: SLEEPING_REFUSAL };
    }
    if (msg === BLOCKED_REFUSAL) {
      return { ok: false, reason: 'blocked', canTopUp: false, product,
        say: BLOCKED_REFUSAL + ' НЕ предлагай пользователю пополнить баланс — это не поможет.' };
    }
    if (msg === 'Недостаточно токенов') {
      return { ok: false, reason: 'no_tokens', canTopUp: true, product,
        say: 'На балансе пользователя нет токенов на ход. Предложи пополнить баланс.' };
    }
    if (msg === 'Агент уже работает над предыдущим запросом') {
      return { ok: false, reason: 'busy', canTopUp: false, product,
        say: 'Продукт уже выполняет предыдущую правку. Дождись её конца (действие status) и повтори.' };
    }
    if (e?.status === 404 || msg === 'Product not found') {
      return { ok: false, reason: 'not_found', product, say: 'Продукт не найден.' };
    }
    this.logger.warn(`edit: продукт ${product.slug} отбил правку: ${msg}`);
    return { ok: false, reason: 'refused', canTopUp: false, product,
      say: `Продукт не принял правку: ${msg || 'причина неизвестна'}` };
  }

  /**
   * Ожидание с потолком. Успели — ассистент рассказывает исход сразу; не
   * успели — честное «идёт» и предложение посмотреть действием status.
   *
   * Ждать до конца нельзя: правка идёт минуты, и ответ чата к тому времени
   * уже не дойдёт. Не ждать совсем — тоже: «поставил» без продолжения это то
   * самое молчаливое «готово».
   */
  private async waitForOutcome(turnId: string): Promise<TurnOutcome> {
    const deadline = Date.now() + this.waitMs;
    let seen = await this.readTurn(turnId);
    while (!seen.finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      seen = await this.readTurn(turnId);
    }
    return seen;
  }

  private async readTurn(turnId: string): Promise<TurnOutcome> {
    const r = await this.pg.query(
      `SELECT id, status, result, error, tokens_spent FROM product_turns WHERE id = $1`,
      [turnId],
    );
    return describeTurn(r.rows[0]);
  }

  /**
   * Владелец в WHERE обоих запросов, включая поиск по turnId: без этого
   * ассистент читал бы исход чужой правки, зная только её идентификатор.
   *
   * Разбор исхода — общий `describeTurn`, тот же, что у `edit`. Свой разбор
   * здесь разъехался бы с тамошним, и «готово» после отката стало бы вопросом
   * того, каким путём ассистент узнал о ходе.
   */
  private async status(userId: string, input: any) {
    const turnId = String(input?.turnId ?? '').trim();
    if (turnId) {
      const r = await this.pg.query(
        `SELECT t.id, t.status, t.result, t.error, t.tokens_spent
           FROM product_turns t
           JOIN products p ON p.id = t.product_id
          WHERE t.id = $1 AND p.user_id = $2 AND p.archived_at IS NULL`,
        [turnId, userId],
      );
      if (!r.rows[0]) {
        return { ok: false, reason: 'not_found', say: 'Такой правки у пользователя нет.' };
      }
      return describeTurn(r.rows[0]);
    }

    const matches = await this.resolve(userId, String(input?.product ?? ''));
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous', matches,
        say: 'Под это описание подходит несколько продуктов. Спроси, про какой именно рассказать.' };
    }
    if (matches.length === 0) {
      return { ok: false, reason: 'not_found', say: 'Такого продукта у пользователя нет.' };
    }

    const r = await this.pg.query(
      `SELECT id, status, result, error, tokens_spent
         FROM product_turns
        WHERE product_id = $1 AND user_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [matches[0].id, userId],
    );
    if (!r.rows[0]) {
      return { ok: false, reason: 'no_turns', product: matches[0],
        say: 'У этого продукта ещё не было ни одной правки.' };
    }
    return { ...describeTurn(r.rows[0]), product: matches[0] };
  }
}

export const PRODUCT_TOOL_NAME = 'manage_product';

/**
 * Один инструмент с перечислением действий, по образцу manage_routine. Три
 * отдельных имени с пересекающимися описаниями модель путает чаще.
 *
 * Аргумента userId здесь нет и быть не должно: владелец приезжает из подписи
 * токена сессии. Общая точка /mcp принимает userId полем запроса — поэтому
 * ЭТОТ инструмент туда не добавляется.
 */
export const PRODUCT_TOOLS = [
  {
    name: PRODUCT_TOOL_NAME,
    description:
      'Посмотреть и ПРАВИТЬ продукты пользователя (сайты и телеграм-боты, которые он разместил в Линкеоне). ' +
      'Ты видишь только продукты этого пользователя — чужих тебе не покажут ни по имени, ни по идентификатору.\n' +
      '• action="list" — показать его продукты: имя, адрес, состояние. У ботов адреса нет вовсе — это норма.\n' +
      '• action="edit" — поставить правку: product (как пользователь назвал продукт) + prompt (что именно сделать, ' +
      'своими словами и подробно — правку исполняет ассистент внутри продукта, он видит только его файлы).\n' +
      '• action="status" — узнать, чем кончилась правка: product или turnId.\n' +
      'ЧТО ВЕРНЁТСЯ У edit/status — поле outcome, и оно значит РАЗНОЕ:\n' +
      '  – "done" — правка применена. Только это успех. Назови пользователю расход в токенах из tokensSpent.\n' +
      '  – "reverted" — ОТКАТ: продукт не прошёл проверку здоровья, код вернули как было. ' +
      'НИКОГДА не говори «готово», «сделал», «применил» — скажи прямо, что правка не прошла и всё вернулось назад.\n' +
      '  – "failed" — правка не выполнена, ход завершился ошибкой. Тоже не успех.\n' +
      '  – "running" / "queued" — правка ещё идёт. Скажи честно, что работа выполняется, и предложи посмотреть ' +
      'через минуту: ты сам вызовешь action="status" с этим turnId.\n' +
      'ВАЖНО: не говори «поправил / сделал / обновил», ПОКА не вызвал инструмент и не получил outcome="done". ' +
      'Не выдумывай эту возможность без вызова.\n' +
      'ЕСЛИ вернулось reason="ambiguous" — под описание подошло несколько продуктов: СПРОСИ у пользователя, ' +
      'какой именно править, и вызови снова с точным именем. Не выбирай сам.\n' +
      'ЕСЛИ reason="sleeping" — продукт спит из-за нехватки токенов на аренду: предложи пополнить баланс. ' +
      'ЕСЛИ reason="blocked" — продукт остановлен администратором: пополнение НЕ ПОМОЖЕТ, не предлагай его.\n' +
      'ЧЕГО ТЫ НЕ МОЖЕШЬ: завести новый продукт (это кнопка в кабинете, вкладка «Продукты»; продуктов не больше ' +
      'двух на аккаунт), погасить продукт, загрузить в него файлы. Не обещай этого.\n' +
      'ПРО ДЕНЬГИ: разговор с тобой и правка продукта тарифицируются ОТДЕЛЬНО. Когда сообщаешь результат правки — ' +
      'назови расход за ход, чтобы два списания за одну просьбу не выглядели ошибкой.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'edit', 'status'] },
        product: {
          type: 'string',
          description: 'Как пользователь назвал продукт: имя («магазин цветов»), слаг или домен. Для edit обязательно.',
        },
        prompt: {
          type: 'string',
          description: 'Что именно сделать с продуктом. Подробно и своими словами. Обязательно для edit.',
        },
        turnId: {
          type: 'string',
          description: 'Идентификатор правки из прошлого вызова edit. Для status вместо product.',
        },
      },
      required: ['action'],
    },
  },
];
