import type { KbArticle } from '../kb.types';
import { V } from '../values';

// источник: создание — spirits_front src/components/products/ProductsListView.tsx:404-481, NewProductForm.tsx:296-488; src/products/products.dto.ts:93-123; src/products/provisioning.service.ts:271
// источник: правки — src/products/product-tool.service.ts:64-86,285-433; src/products/turns.service.ts:309-561; product-runner/src/config.ts:62
// источник: откат — spirits_front src/components/products/TurnHistory.tsx:20-84; src/products/turns.service.ts:514-537
// источник: аренда и сон — src/products/rent.service.ts (RENT_TOKENS), migrations/004_rent.sql:8-30
// источник: домен — src/products/domains.service.ts:112-151,359-381,593-668; domain-name.ts:199-207
// источник: ключи — src/products/secrets.service.ts:12; spirits_front NewProductForm.tsx:376-460
// источник: лимит — src/products/limits.service.ts (DEFAULT_MAX_PRODUCTS)
// источник: опрос Telegram — product-runner/src/host/skeleton.ts:267-300
export const products: KbArticle = {
  id: 'products',
  title: 'Продукты: сайты и боты',
  summary: 'продукты: свой сайт или Telegram-бот на Linkeon — создание, правки словами, откат, свой домен, ключи, аренда',
  related: ['studio-bots', 'tokens', 'support'],
  render: ({ q, paid }) => `
## Что это
Свой сайт или Telegram-бот, который Linkeon размещает у себя и дорабатывает по просьбам обычными словами.

## Где
${q('studio')} → ${q('studioProducts')}. Новый продукт заводится только там — в чате ассистент его не создаёт.

## Как
- ${q('prodNew')} → ${q('prodSite')} (название и адрес латиницей) или ${q('prodBot')} (название, ${q('prodToken')} от BotFather, при нужде ${q('prodSecrets')}). Заведение — до десяти минут.
- Правка: в продукте ${q('prodAsk')} → отправить, или попросить любого ассистента в чате. Одна правка за раз, идёт до двадцати минут и не прерывается, если закрыть вкладку. Итог — в ${q('prodHistory')}.
- ${q('prodRevert')} откатывает правку: возвращается код, данные остаются.
- ${q('prodSecrets')} — пары «имя — значение» для сторонних сервисов; хранятся зашифрованными, после создания не меняются. Значения в чат не присылать.
- ${q('prodDomain')} (только у сайта, один${paid(', бесплатно')}): домен → ${q('prodAttach')} → записи DNS дословно из таблицы; у этих имён удалить прочие A и все AAAA.

## Лимиты и цены
${paid(`- Первый месяц бесплатно, дальше — ${V.rentTokens} токенов в месяц.\n- Правка оплачивается по расходу, только если она применена; откат и неудача бесплатны.`)}
- До ${V.maxProducts} продуктов на аккаунт (кроме архивных); больше — по просьбе в поддержку.

## Чего нельзя
- Удалить или переименовать продукт сам — только через поддержку.
- Свой домен у бота; сменить ${q('prodToken')} или ключ после создания.

## Если не получается
${paid(`- ${q('prodSleeping')} — не хватило токенов на аренду: код и данные целы, проснётся сам после пополнения.`)}
- ${q('prodFailed')} — ${q('prodWhy')}, затем ${q('prodRetry')}.
- Остановлен администратором — ${q('writeSupport')}.
- Домен не открывается — DNS расходится до суток; первую неделю платформа проверяет сама, потом — ${q('prodCheck')}.
- Бот молчит — проверить, что тот же ${q('prodToken')} не использует другой сервис.
- Ничего не помогло — ${q('support')} в разделе ${q('help')}.

## Как устроено
Продукт работает на серверах Linkeon; правки вносит ассистент внутри продукта и проверяет сборку — если после правки продукт нездоров, код откатывается сам. Сертификат домена выпускает Let's Encrypt.
`,
};
