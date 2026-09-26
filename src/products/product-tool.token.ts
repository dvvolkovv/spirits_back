import * as jwt from 'jsonwebtoken';

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

/** Что несёт проверенный токен. */
export interface ProductToolClaims {
  userId: string;
  channel: ProductToolChannel;
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

/**
 * Чистые функции, а не сервис Nest, сознательно. Чеканит их chat.service, у
 * которого конструктор уже на 26 зависимостей и с десятком @Optional: ещё один
 * необязательный параметр молча выключил бы инструмент при ошибке в модуле —
 * ровно тот тихий отказ, которым этот проект уже наелся.
 *
 * Канал по умолчанию — web: так чеканит релей (веб-ассистенты), и так же
 * разбираются токены, выпущенные до появления канала.
 */
export function signProductToolToken(userId: string, channel: ProductToolChannel = 'web'): string {
  // Незнакомый канал — отказ: без срока jwt.sign выпустил бы вечный токен.
  const ttl = TTL_SECONDS[channel];
  if (!ttl) throw new Error(`Неизвестный канал: ${channel}`);
  return jwt.sign({ userId, type: PRODUCT_TOOL_TOKEN_TYPE, channel }, secret(), { expiresIn: ttl });
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
  const payload: any = jwt.verify(token, secret());
  if (payload?.type !== PRODUCT_TOOL_TOKEN_TYPE) {
    throw new Error(`Неверный тип токена: ${payload?.type}`);
  }
  const userId = payload?.userId;
  if (!userId || typeof userId !== 'string') {
    throw new Error('В токене нет владельца');
  }
  const raw = payload?.channel;
  if (raw === undefined || raw === null) return { userId, channel: 'web' };
  if (raw !== 'web' && raw !== 'telegram') {
    throw new Error(`Неизвестный канал в токене: ${raw}`);
  }
  return { userId, channel: raw };
}
