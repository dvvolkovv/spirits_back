import type { KbArticle } from '../kb.types';
import { V } from '../values';

// источник: создание — spirits_front src/components/products/ProductsListView.tsx:404-481, NewProductForm.tsx:296-488; src/products/products.dto.ts:93-123; src/products/provisioning.service.ts:271
// источник: правки — src/products/product-tool.service.ts:64-86,285-433; src/products/turns.service.ts:309-561; product-runner/src/config.ts:62
// источник: откат — spirits_front src/components/products/TurnHistory.tsx:20-84; src/products/turns.service.ts:514-537
// источник: аренда и сон — src/products/rent.service.ts (RENT_TOKENS, FREE_MONTH_PRODUCTS), migrations/004_rent.sql:8-30; бесплатный месяц — provisioning.service.ts (create, решение владельца 26.10.2026)
// источник: домен — src/products/domains.service.ts:112-151,359-381,593-668; domain-name.ts:199-207
// источник: ключи — src/products/secrets.service.ts:12; spirits_front NewProductForm.tsx:376-460
// источник: лимит — src/products/limits.service.ts (DEFAULT_MAX_PRODUCTS)
// источник: опрос Telegram — product-runner/src/host/skeleton.ts:267-300
// источник: ассистентом — src/products/product-lifecycle-tool.ts, product-lifecycle.service.ts (DELETE_GRACE_DAYS); карточки — product-actions.controller.ts, tg-bot/tg-product-actions.service.ts
export const products: KbArticle = {
  id: 'products',
  title: 'Продукты: сайты и боты',
  summary: 'продукты: свой сайт или Telegram-бот на Linkeon — создание, правки словами, удаление, откат, домен, ключи, аренда',
  related: ['studio-bots', 'tokens', 'support'],
  render: ({ q, paid }) => `
## Что это
Свой сайт или Telegram-бот, который Linkeon размещает у себя и дорабатывает по просьбам обычными словами.

## Где
${q('studio')} → ${q('studioProducts')}. Завести продукт можно там или попросив ассистента; удалить и вернуть удалённый — только попросив ассистента.

## Как
- ${q('prodNew')} → ${q('prodSite')} (название и адрес латиницей) или ${q('prodBot')} (название, ${q('prodToken')} от BotFather, при нужде ${q('prodSecrets')}). Заведение — до десяти минут.
- Попросить ассистента завести продукт: сайт он заводит сразу, для бота присылает защищённую карточку — туда вводятся ${q('prodToken')} и ключи. В переписку их не присылать.
- Правка: в продукте ${q('prodAsk')} → отправить, или попросить любого ассистента в чате. Одна правка за раз, идёт до двадцати минут и не прерывается, если закрыть вкладку. Итог — в ${q('prodHistory')}.
- ${q('prodRevert')} откатывает правку: возвращается код, данные остаются. Откатить можно и попросив ассистента.
- Удалить: попросить ассистента — продукт удалится только кнопкой «Удалить» в карточке (в Telegram — кнопкой в сообщении). Выключается сразу; вернуть можно в течение ${V.deleteGraceDays} дней, если есть свободное место в пределе продуктов.${paid(' Оплаченный период не возвращается.')}
- ${q('prodSecrets')} — пары «имя — значение» для сторонних сервисов; хранятся зашифрованными, после создания не меняются. Значения в чат не присылать.
- ${q('prodDomain')} (только у сайта, один${paid(', бесплатно')}): домен → ${q('prodAttach')} → записи DNS дословно из таблицы; у этих имён удалить прочие A и все AAAA.

## Лимиты и цены
${paid(`- Первый месяц бесплатно — только первым ${V.freeMonthProducts} продуктам аккаунта за всё время, включая удалённые; дальше — ${V.rentTokens} токенов в месяц.\n- Правка — по расходу, если применена; откат и неудача бесплатны.`)}
- До ${V.maxProducts} продуктов на аккаунт (кроме архивных); больше — по просьбе в поддержку.

## Чего нельзя
- Переименовать продукт — только через поддержку.
- Вернуть продукт, удалённый больше ${V.deleteGraceDays} дней назад.
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
