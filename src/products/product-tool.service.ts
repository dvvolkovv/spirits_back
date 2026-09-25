import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { PRODUCT_TOOL_WAIT_MS } from '../common/relay-budget';
import { TurnsService, SLEEPING_REFUSAL, BLOCKED_REFUSAL } from './turns.service';
import { DomainErrorReason, DomainRecordToSet, DomainStatus, DomainsService, DomainView } from './domains.service';
import { normalizeDomain } from './domain-name';

/** Продукт глазами ассистента: без внутренностей, только то, что можно назвать вслух. */
export interface ProductMatch {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  kind: string;
  status: string;
}

/** Строка `list`: продукт плюс его свой домен, если он есть. */
export interface ProductListRow extends ProductMatch {
  custom_domain: string | null;
  custom_domain_status: DomainStatus | null;
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

/**
 * Свой домен в ответе инструмента. Из DomainView уходит всё, что писали НЕ
 * мы:
 *   - `error` — сырой текст отказа агента (certbot цитирует ответ сервера
 *     пользователя, бывает длинным) — вместо него текст по `errorReason`
 *     (DOMAIN_FAILED_SAY);
 *   - у проверки `current` — что сейчас лежит в DNS: TXT пишет владелец ЧУЖОГО
 *     домена, и это прямой канал prompt-injection в контекст модели; `error` —
 *     код резолвера, ассистенту без пользы. Остаётся тип, имя и «сходится ли».
 * Записи (`records`) — наши целиком: код заявки, IP машины, адрес продукта.
 */
export interface DomainForAssistant {
  domain: string;
  domainUnicode: string;
  names: string[];
  status: DomainStatus;
  errorReason: DomainErrorReason | null;
  checkedAt: string | null;
  check: { type: string; name: string; ok: boolean }[] | null;
  records: DomainRecordToSet[];
}

export function domainForAssistant(v: DomainView): DomainForAssistant {
  return {
    domain: v.domain,
    domainUnicode: v.domainUnicode,
    names: v.names,
    status: v.status,
    errorReason: v.errorReason,
    checkedAt: v.checkedAt,
    check: v.check ? v.check.map((c) => ({ type: c.type, name: c.name, ok: c.ok })) : null,
    records: v.records,
  };
}

const NOT_WORKING = ' Не говори, что домен работает.';

/**
 * Что сказать про отказавшую заявку — по коду причины, а не по `error`
 * (сырой текст агента, см. domainForAssistant). Record по типу: новая причина
 * без текста не скомпилируется, а тест сверяет список со словарём 008.
 */
export const DOMAIN_FAILED_SAY: Record<DomainErrorReason, string> = {
  issue_failed:
    'Сертификат не выпустился: Let\'s Encrypt не смог проверить домен. Частые причины — остались старые A/AAAA-записи ' +
    'или DNS ещё не разошёлся. Можно проверить снова.' + NOT_WORKING,
  agent_outdated:
    'Временный сбой на стороне платформы, попытка не засчитана. Предложи проверить снова чуть позже.' + NOT_WORKING,
  // taken пишет выпуск, когда тот же домен в тот же миг ушёл в выпуск у
  // ДРУГОГО продукта (любого владельца) — чей он, пользователю не говорим.
  taken:
    'Этот домен уже привязан к другому продукту, и сертификат для этого не выпустится. Если тот продукт тоже ' +
    'пользователя — пусть сначала отвяжет домен там; иначе нужен другой домен. Эту заявку можно отвязать.' + NOT_WORKING,
  orphan_issuing:
    'Выпуск сертификата прервался: задание сняли (продукт остановлен или машина не ответила вовремя). ' +
    'Можно проверить снова.' + NOT_WORKING,
  // Обе причины отвязки — «Проверить снова» здесь выпустил бы домен заново
  // (DETACH_PENDING в domains.service.ts): путь один — отвязать ещё раз.
  orphan_removing:
    'Отвязка прервалась: задание сняли (продукт остановлен или машина не ответила вовремя). ' +
    'Отвяжи домен ещё раз (remove: true); проверять снова не нужно.',
  remove_failed:
    'Отвязка не удалась на стороне платформы. Отвяжи домен ещё раз (remove: true); проверять снова не нужно.',
};

/** Что не сходится в последней проверке DNS — по нашим именам, без чужих значений. */
function mismatches(v: DomainView): string {
  const bad = (v.check ?? []).filter((c) => !c.ok);
  if (!bad.length) return '';
  const what = bad.map((c) =>
    c.type === 'TXT' ? `нет TXT с кодом у ${c.name}`
      : c.type === 'AAAA' ? `у ${c.name} есть AAAA — удалить`
      : `A у ${c.name} не та или её нет`,
  );
  return ` По последней проверке не сходится: ${what.join('; ')}.`;
}

/**
 * Единственное место, где состояние своего домена становится новостью.
 * «Домен работает» — ТОЛЬКО у active: пересказ ждущей заявки как готовой —
 * та же ложь, что «готово» после отката правки.
 */
export function domainSay(v: DomainView | null): string {
  if (!v) return 'Своего домена у продукта нет.';
  switch (v.status) {
    case 'active':
      return v.domainUnicode !== v.domain
        ? `Домен работает: https://${v.domainUnicode} (в DNS и у регистратора — ${v.domain}).`
        : `Домен работает: https://${v.domain}`;
    case 'issuing':
      return 'DNS в порядке, сертификат выпускается — обычно меньше минуты. Пока не говори, что домен работает.';
    case 'failed':
      return (v.errorReason && DOMAIN_FAILED_SAY[v.errorReason]) || 'Выпуск не удался. Можно проверить снова.' + NOT_WORKING;
    case 'removing':
      return 'Домен отвязывается.';
    default:
      return (
        'Домен ждёт изменения DNS. Назови пользователю записи ДОСЛОВНО из records (тип, имя, значение) и скажи ' +
        'удалить у этих имён остальные A-записи и ВСЕ AAAA — иначе сертификат не выпустится. Изменения DNS ' +
        'расходятся от 15 минут до суток, платформа проверяет сама. Это бесплатно. Не говори, что домен уже подключён.' +
        mismatches(v)
      );
  }
}

@Injectable()
export class ProductToolService {
  private readonly logger = new Logger(ProductToolService.name);

  constructor(
    private readonly pg: PgService,
    private readonly turns: TurnsService,
    private readonly domains: DomainsService,
  ) {}

  /**
   * Нестрогий поиск по имени плюс точные совпадения по слагу, домену и
   * идентификатору: последние три ассистент мог взять из `list` в том же
   * разговоре. И по своему домену продукта — любой заявке, в любом статусе:
   * человек называет сайт тем адресом, который купил. Запрос приводится той
   * же normalizeDomain, что и привязка (схема, путь, регистр, www, punycode);
   * не домен по её меркам (имя, слаг, наша зона) — сравнения по своему домену
   * нет вовсе.
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
    const n = normalizeDomain(raw);
    const own = n.ok === true ? n.domain : null;
    const r = await this.pg.query(
      `SELECT id, name, slug, domain, kind, status
         FROM products
        WHERE user_id = $1 AND archived_at IS NULL
          AND ( id::text = $2
             OR lower(slug) = $2
             OR lower(domain) = $2
             OR lower(name) LIKE $3
             OR EXISTS (SELECT 1 FROM product_domains d WHERE d.product_id = products.id AND d.domain = $4) )
        ORDER BY created_at DESC`,
      [userId, raw, like, own],
    );
    return r.rows;
  }

  /**
   * Единственный вход инструмента. Владелец — ПЕРВЫМ аргументом и приезжает из
   * проверенной подписи токена (см. точку /webhook/mcp/products), а не из поля
   * запроса: инструменту продуктов аргумента `userId` не дано вовсе.
   */
  async execute(userId: string, input: any): Promise<any> {
    const action = String(input?.action ?? '').trim();
    if (action === 'list') return this.list(userId);
    if (action === 'edit') return this.edit(userId, input);
    if (action === 'status') return this.status(userId, input);
    if (action === 'domain') return this.domain(userId, input);
    return {
      ok: false,
      reason: 'bad_action',
      say: 'Неизвестное действие. Доступны: list (показать продукты), edit (поставить правку), ' +
           'status (узнать исход правки), domain (свой домен сайта).',
    };
  }

  private async list(userId: string) {
    // Строка своего домена — одна на продукт (PK product_id), JOIN не множит.
    const products = await this.pg
      .query(
        `SELECT p.id, p.name, p.slug, p.domain, p.kind, p.status,
                d.domain AS custom_domain, d.status AS custom_domain_status
           FROM products p
           LEFT JOIN product_domains d ON d.product_id = p.id
          WHERE p.user_id = $1 AND p.archived_at IS NULL
          ORDER BY p.created_at DESC`,
        [userId],
      )
      .then((r) => r.rows as ProductListRow[]);

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
   * Свой домен сайта. Продукт — тем же нестрогим поиском, что у edit; дальше
   * всё решает DomainsService (владелец, статусы, пределы, гонки) — здесь
   * только выбор его метода и пересказ.
   *
   * Порядок флагов: remove, затем check, затем domain, иначе состояние.
   * Отвязка — первой: «отвязать» с доменом в придачу не должно превратиться
   * в привязку. check раньше domain: привязка того же домена при живой заявке
   * DNS не перепроверяет (answerExisting), а просили именно проверку.
   *
   * Отказ сервиса — HttpException с телом { message, reason }: reason уходит
   * машинным кодом, message — текстом. Прочие ошибки — наверх: это сбой, а
   * не ответ.
   */
  private async domain(userId: string, input: any) {
    const matches = await this.resolve(userId, String(input?.product ?? ''));
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous', matches,
        say: 'Под это описание подходит несколько продуктов. СПРОСИ, к какому привязывать домен.' };
    }
    if (matches.length === 0) {
      return { ok: false, reason: 'not_found', say: 'Такого продукта у пользователя нет.' };
    }
    const product = matches[0];
    const raw = typeof input?.domain === 'string' ? input.domain.trim() : '';
    try {
      if (input?.remove === true) {
        const { removed } = await this.domains.detach(userId, product.id);
        return { ok: true, product, removed,
          say: removed === 'now' ? 'Домен отвязан.' : 'Отвязка поставлена — займёт до минуты.' };
      }
      let view: DomainView | null;
      if (input?.check === true) view = await this.domains.check(userId, product.id);
      else if (raw) view = await this.domains.attach(userId, product.id, raw);
      else view = await this.domains.get(userId, product.id);
      return { ok: true, product, domain: view ? domainForAssistant(view) : null, say: domainSay(view) };
    } catch (e: any) {
      if (!(e instanceof HttpException)) throw e;
      const body: any = e.getResponse();
      return {
        ok: false,
        reason: typeof body?.reason === 'string' ? body.reason : 'refused',
        product,
        say: typeof body?.message === 'string' ? body.message : e.message,
      };
    }
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
 * Один инструмент с перечислением действий, по образцу manage_routine. Четыре
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
      '• action="domain" — свой домен сайта: { product, domain } — привязать; { product } — узнать состояние; ' +
      '{ product, check: true } — проверить DNS сейчас; { product, remove: true } — отвязать. Вернутся records — ' +
      'записи для регистратора: называй их ДОСЛОВНО (тип, имя, значение), не пересказывая, и обязательно скажи ' +
      'удалить у этих имён остальные A-записи и ВСЕ AAAA. Не говори «домен работает», пока domain.status не ' +
      '"active". Свой домен бесплатный, входит в аренду. Бывает только у сайта, один на продукт.\n' +
      'ДВА РАЗНЫХ ПОЛЯ В ОТВЕТЕ, и они НИКОГДА не приходят вместе. Если правку приняли в работу — придёт ' +
      'outcome (чем кончился ход). Если правку не приняли вовсе — придёт reason (почему отказали), и никакого ' +
      'outcome не будет. Не ищи outcome в отказе и не выдавай отказ за исход.\n' +
      'ЕСЛИ ПРИШЁЛ outcome — он значит РАЗНОЕ:\n' +
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
        action: { type: 'string', enum: ['list', 'edit', 'status', 'domain'] },
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
        domain: {
          type: 'string',
          description: 'Свой домен пользователя для action="domain" (например, "mysite.ru"). Без него — узнать состояние.',
        },
        remove: {
          type: 'boolean',
          description: 'Для action="domain": true — отвязать свой домен.',
        },
        check: {
          type: 'boolean',
          description:
            'Для action="domain": true — проверить DNS сейчас (после того как пользователь поменял записи или после отказа выпуска).',
        },
      },
      required: ['action'],
    },
  },
];
