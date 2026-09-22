import * as jwt from 'jsonwebtoken';

/**
 * Отдельный тип, а не 'access'. Токен уезжает на релей и живёт там в файле
 * MCP-конфига — то есть за пределами нашего периметра. Своим типом он не
 * годится ни для одной защищённой ручки: JwtGuard требует type='access'
 * (src/common/guards/jwt.guard.ts:25).
 */
export const PRODUCT_TOOL_TOKEN_TYPE = 'product-tool';

/** Заметно дольше бюджета хода (10 мин) и заметно короче суток. */
const TTL_SECONDS = 30 * 60;

function secret(): string {
  return process.env.JWT_SECRET || 'default_secret_change_me';
}

/**
 * Чистые функции, а не сервис Nest, сознательно. Чеканит их chat.service, у
 * которого конструктор уже на 26 зависимостей и с десятком @Optional: ещё один
 * необязательный параметр молча выключил бы инструмент при ошибке в модуле —
 * ровно тот тихий отказ, которым этот проект уже наелся.
 */
export function signProductToolToken(userId: string): string {
  return jwt.sign({ userId, type: PRODUCT_TOOL_TOKEN_TYPE }, secret(), { expiresIn: TTL_SECONDS });
}

/** Отдаёт владельца или бросает. Возврата «не знаю» нет: без владельца работать нечем. */
export function verifyProductToolToken(token: string): string {
  const payload: any = jwt.verify(token, secret());
  if (payload?.type !== PRODUCT_TOOL_TOKEN_TYPE) {
    throw new Error(`Неверный тип токена: ${payload?.type}`);
  }
  const userId = payload?.userId;
  if (!userId || typeof userId !== 'string') {
    throw new Error('В токене нет владельца');
  }
  return userId;
}
