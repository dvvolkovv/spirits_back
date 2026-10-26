import { ProductToolTokenOpts, signProductToolToken } from '../products/product-tool.token';

/**
 * Поля, которыми бэкенд передаёт релею доступ к инструменту продуктов.
 *
 * Чистая функция, а не метод сервиса: конструктор ChatService уже на 26
 * зависимостей, половина из них @Optional — ещё одна необязательная молча
 * выключила бы инструмент при ошибке в модуле.
 *
 * Адрес — `/webhook/mcp/products`, а не `/mcp/products`: исключение глобального
 * префикса в main.ts покрывает точный путь `mcp`, но не его подпути. Измерено
 * живым приложением; на тестовом стенде вдобавок нет блока `location /mcp` в
 * nginx, и `/mcp/products` вернул бы там 200 с HTML.
 *
 * Шлётся ВСЕГДА, всем ассистентам. У пользователя без продуктов инструмент
 * честно ответит «нет ни одного» — это дешевле, чем запрос в базу на каждом
 * ходе ради того, чтобы иногда не показать инструмент.
 *
 * opts — язык, клиент и вид ассистента для справки (platform-kb) и метка хода
 * (opts.turn — по ней чат забирает карточки продуктов): едут в подписи токена.
 */
export function productsRelayFields(
  userId: string,
  opts: ProductToolTokenOpts = {},
): { products_token: string; products_mcp_url: string } {
  const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
  return {
    products_token: signProductToolToken(userId, 'web', opts),
    products_mcp_url: `${base}/webhook/mcp/products`,
  };
}
