import * as jwt from 'jsonwebtoken';

/**
 * Токен хода для инструментов Linkeon (mcp__linkeon__*: картинки, баннеры,
 * видео, озвучка, рутины, календарь, бодиграф). Спека:
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 *
 * Бэк выпускает его на каждый ход и отдаёт релею (src/chat/linkeon-relay-fields.ts);
 * релей кладёт его в заголовок сервера linkeon, точка /webhook/mcp/linkeon
 * берёт пользователя из подписи. Модель токена не видит и пользователя в
 * аргументах больше не пишет.
 *
 * Свой тип, а не 'access': токен живёт на релее в файле конфига хода, то есть
 * за нашим периметром, и не должен открывать ни одной защищённой ручки —
 * JwtGuard требует type='access' (src/common/guards/jwt.guard.ts). По образцу
 * src/products/product-tool.token.ts; чистые функции по той же причине.
 */
export const LINKEON_TOOL_TOKEN_TYPE = 'linkeon-tool';

/** Дольше любого хода (веб — до 10 минут с продолжениями, agentReply — 5) и заметно короче суток. */
const TTL_SECONDS = 30 * 60;

function secret(): string {
  return process.env.JWT_SECRET || 'default_secret_change_me';
}

/** Прежний секрет на время его смены — как в JwtService. */
function previousSecret(): string | null {
  return process.env.JWT_SECRET_PREVIOUS || null;
}

export function signLinkeonToolToken(userId: string): string {
  if (!userId || typeof userId !== 'string') {
    throw new Error('Токен хода без пользователя не выпускается');
  }
  return jwt.sign({ userId, type: LINKEON_TOOL_TOKEN_TYPE }, secret(), { expiresIn: TTL_SECONDS });
}

/** Пользователь из подписи или исключение: без пользователя звать инструмент нечем. */
export function verifyLinkeonToolToken(token: string): { userId: string } {
  let payload: any;
  try {
    payload = jwt.verify(token, secret());
  } catch (e) {
    // Токен, выпущенный до смены секрета, доживает свой срок; просроченный — нет.
    const prev = previousSecret();
    if (!prev || e instanceof jwt.TokenExpiredError) throw e;
    payload = jwt.verify(token, prev);
  }
  if (payload?.type !== LINKEON_TOOL_TOKEN_TYPE) {
    throw new Error(`Неверный тип токена: ${payload?.type}`);
  }
  const userId = payload?.userId;
  if (!userId || typeof userId !== 'string') {
    throw new Error('В токене нет пользователя');
  }
  return { userId };
}
