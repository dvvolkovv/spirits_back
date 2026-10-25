import * as jwt from 'jsonwebtoken';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * Отдельный тип, а не 'access'. Токен уезжает на релей и живёт там в файле
 * MCP-конфига — то есть за пределами нашего периметра. Своим типом он не
 * годится ни для одной защищённой ручки: JwtGuard требует type='access'
 * (src/common/guards/jwt.guard.ts:25).
 */
export const PRODUCT_TOOL_TOKEN_TYPE = 'product-tool';

/**
 * Канал, из которого ассистент ставит правку: он же ложится в
 * product_turns.channel. Живёт в подписи, а не в запросе — по той же причине,
 * что и владелец: поле запроса пишет модель.
 */
export type ProductToolChannel = 'web' | 'telegram';

/**
 * Для справки (platform-kb): на каком клиенте ход и на каком языке подписи.
 * Едут в подписи по той же причине, что владелец и канал: поле запроса пишет
 * модель.
 *   client — web | app (Flutter) | store (сборки из сторов) | telegram;
 *   scope  — full (по умолчанию) или help: только справка, без продуктов и
 *            файлов, — для ходов Telegram-группы с посторонними;
 *   agent  — staff | custom, только для учёта вызовов справки.
 * Все поля необязательны: токен без них (выпущенный до 24.10.2026) — прежний.
 */
export type ProductToolClient = 'web' | 'app' | 'store' | 'telegram';
export type ProductToolScope = 'full' | 'help';
export type ProductToolAgent = 'staff' | 'custom';

const CLIENTS: readonly string[] = ['web', 'app', 'store', 'telegram'];
const SCOPES: readonly string[] = ['full', 'help'];
const AGENTS: readonly string[] = ['staff', 'custom'];

export interface ProductToolTokenOpts {
  lang?: string;
  client?: ProductToolClient;
  scope?: ProductToolScope;
  agent?: ProductToolAgent;
}

/** Что несёт проверенный токен. */
export interface ProductToolClaims extends ProductToolTokenOpts {
  userId: string;
  channel: ProductToolChannel;
}

/**
 * Необязательные поля — одна проверка на выпуск и на разбор. Незнакомое
 * значение подписать могли только мы сами, то есть это ошибка в коде: отказ,
 * как у незнакомого канала. scope=full не пишется вовсе — его отсутствие и есть full.
 */
function extraClaims(src: any): ProductToolTokenOpts {
  const out: ProductToolTokenOpts = {};
  const check = (field: string, value: unknown, allowed: readonly string[]) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new Error(`Неизвестное значение ${field} в токене: ${value}`);
    }
  };
  if (src?.lang != null) { check('lang', src.lang, SUPPORTED_LANGUAGES); out.lang = src.lang; }
  if (src?.client != null) { check('client', src.client, CLIENTS); out.client = src.client; }
  if (src?.scope != null) { check('scope', src.scope, SCOPES); if (src.scope === 'help') out.scope = 'help'; }
  if (src?.agent != null) { check('agent', src.agent, AGENTS); out.agent = src.agent; }
  return out;
}

/**
 * Сколько живёт токен — по каналу.
 *   • web: заметно дольше бюджета хода (10 мин) и заметно короче суток.
 *   • telegram: у хода бота таймаута нет вовсе (tg-router: timeoutMs 0 —
 *     прогресс виден статусом в чате), и 30 минут оборвали бы доступ к
 *     продуктам посреди долгого хода. 2 часа — дольше любого разумного хода
 *     бота и всё так же заметно короче суток.
 */
const TTL_SECONDS: Record<ProductToolChannel, number> = {
  web: 30 * 60,
  telegram: 2 * 60 * 60,
};

function secret(): string {
  return process.env.JWT_SECRET || 'default_secret_change_me';
}

/** Прежний секрет на время его смены — как в JwtService. */
function previousSecret(): string | null {
  return process.env.JWT_SECRET_PREVIOUS || null;
}

/**
 * Чистые функции, а не сервис Nest, сознательно. Чеканит их chat.service, у
 * которого конструктор уже на 26 зависимостей и с десятком @Optional: ещё один
 * необязательный параметр молча выключил бы инструмент при ошибке в модуле —
 * ровно тот тихий отказ, которым этот проект уже наелся.
 *
 * Канал по умолчанию — web: так чеканит релей (веб-ассистенты), и так же
 * разбираются токены, выпущенные до появления канала.
 */
export function signProductToolToken(
  userId: string,
  channel: ProductToolChannel = 'web',
  opts: ProductToolTokenOpts = {},
): string {
  // Незнакомый канал — отказ: без срока jwt.sign выпустил бы вечный токен.
  const ttl = TTL_SECONDS[channel];
  if (!ttl) throw new Error(`Неизвестный канал: ${channel}`);
  return jwt.sign({ userId, type: PRODUCT_TOOL_TOKEN_TYPE, channel, ...extraClaims(opts) }, secret(), { expiresIn: ttl });
}

/**
 * Отдаёт владельца и канал или бросает. Возврата «не знаю» нет: без владельца
 * работать нечем.
 *
 * Канала нет — токен выпущен до его появления (на релее такие живут до 30
 * минут после выката), это веб. Незнакомый канал подписать могли только мы
 * сами, то есть это ошибка в коде: записать его «вебом» значило бы соврать в
 * истории правок, поэтому — отказ.
 */
export function verifyProductToolToken(token: string): ProductToolClaims {
  let payload: any;
  try {
    payload = jwt.verify(token, secret());
  } catch (e) {
    // Токен, выпущенный до смены секрета, доживает свой срок; просроченный — нет.
    const prev = previousSecret();
    if (!prev || e instanceof jwt.TokenExpiredError) throw e;
    payload = jwt.verify(token, prev);
  }
  if (payload?.type !== PRODUCT_TOOL_TOKEN_TYPE) {
    throw new Error(`Неверный тип токена: ${payload?.type}`);
  }
  const userId = payload?.userId;
  if (!userId || typeof userId !== 'string') {
    throw new Error('В токене нет владельца');
  }
  const raw = payload?.channel;
  const channel = raw === undefined || raw === null ? 'web' : raw;
  if (channel !== 'web' && channel !== 'telegram') {
    throw new Error(`Неизвестный канал в токене: ${raw}`);
  }
  return { userId, channel, ...extraClaims(payload) };
}
